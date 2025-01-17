import JSBI from 'jsbi'
import { Contract } from '@ethersproject/contracts'
import { getNetwork } from '@ethersproject/networks'
import { getDefaultProvider } from '@ethersproject/providers'
import { TokenAmount } from './entities/fractions/tokenAmount'
import { Pair } from './entities/pair'
import IDXswapPair from 'dxswap-core/build/contracts/IDXswapPair.json'
import IDXswapFactory from 'dxswap-core/build/contracts/IDXswapFactory.json'
import invariant from 'tiny-invariant'
import ERC20 from './abis/ERC20.json'
import { ChainId, BigintIsh, FACTORY_ADDRESS, MULTICALL_ADDRESS, MULTICALL_ABI } from './constants'
import { Token } from './entities/token'

let TOKEN_DECIMALS_CACHE: { [chainId: number]: { [address: string]: number } } = {
  [ChainId.MAINNET]: {
    '0xE0B7927c4aF23765Cb51314A0E0521A9645F0E2A': 9 // DGD
  }
}

/**
 * Contains methods for constructing instances of pairs and tokens from on-chain data.
 */
export abstract class Fetcher {
  /**
   * Cannot be constructed.
   */
  private constructor() {}

  /**
   * Fetch information for a given token on the given chain, using the given ethers provider.
   * @param chainId chain of the token
   * @param address address of the token on the chain
   * @param provider provider used to fetch the token
   * @param symbol optional symbol of the token
   * @param name optional name of the token
   */
  public static async fetchTokenData(
    chainId: ChainId,
    address: string,
    provider = getDefaultProvider(getNetwork(chainId)),
    symbol?: string,
    name?: string
  ): Promise<Token> {
    const parsedDecimals =
      typeof TOKEN_DECIMALS_CACHE?.[chainId]?.[address] === 'number'
        ? TOKEN_DECIMALS_CACHE[chainId][address]
        : await new Contract(address, ERC20, provider).decimals().then((decimals: number): number => {
            TOKEN_DECIMALS_CACHE = {
              ...TOKEN_DECIMALS_CACHE,
              [chainId]: {
                ...TOKEN_DECIMALS_CACHE?.[chainId],
                [address]: decimals
              }
            }
            return decimals
          })
    return new Token(chainId, address, parsedDecimals, symbol, name)
  }

  /**
   * Fetches information about a pair and constructs a pair from the given two tokens.
   * @param tokenA first token
   * @param tokenB second token
   * @param provider the provider to use to fetch the data
   */
  public static async fetchPairData(
    tokenA: Token,
    tokenB: Token,
    provider = getDefaultProvider(getNetwork(tokenA.chainId))
  ): Promise<Pair> {
    invariant(tokenA.chainId === tokenB.chainId, 'CHAIN_ID')
    const address = Pair.getAddress(tokenA, tokenB)
    const [reserves0, reserves1] = await new Contract(address, IDXswapPair.abi, provider).getReserves()
    const balances = tokenA.sortsBefore(tokenB) ? [reserves0, reserves1] : [reserves1, reserves0]
    const tokenAmountA = new TokenAmount(tokenA, balances[0])
    const tokenAmountB = new TokenAmount(tokenB, balances[1])
    const tokenAmounts = tokenAmountA.token.sortsBefore(tokenAmountB.token) // does safety checks
      ? [tokenAmountA, tokenAmountB]
      : [tokenAmountB, tokenAmountA]
    const liquidityToken = new Token(
      tokenAmounts[0].token.chainId,
      Pair.getAddress(tokenAmounts[0].token, tokenAmounts[1].token),
      18,
      'DXS',
      'DXswap'
    )
    const swapFee = JSBI.BigInt(await new Contract(liquidityToken.address, IDXswapPair.abi, provider).swapFee())
    const protocolFeeDenominator = JSBI.BigInt(await new Contract(
      FACTORY_ADDRESS[tokenAmountA.token.chainId],
      IDXswapFactory.abi,
      provider
    ).protocolFeeDenominator())
    return new Pair(tokenAmountA, tokenAmountB, swapFee, protocolFeeDenominator)
  }
  
  /**
   * Fetches swap fee information from a liquidity token of a token pair
   * @param liquidityToken the liquidity token from which the swap fee info will be fetched
   * @param provider the provider to use to fetch the data
   */
  public static async fetchSwapFee(
    liquidityToken: Token,
    provider = getDefaultProvider(getNetwork(liquidityToken.chainId)),
  ) : Promise<{
    fee: BigintIsh
    owner: string
  }> {
    return {
      fee: JSBI.BigInt(await new Contract(liquidityToken.address, IDXswapPair.abi, provider).swapFee()),
      owner: await new Contract(
        FACTORY_ADDRESS[liquidityToken.chainId],
        IDXswapFactory.abi,
        provider
      ).feeToSetter()
    }
  }
    
  /**
   * Fetches swap fee information from liquidity tokens of token pairs
   * @param liquidityToken the liquidity tokens from which the swap fee info will be fetched
   * @param provider the provider to use to fetch the data
   */
  public static async fetchSwapFees(
    liquidityTokens: Token[],
    provider = getDefaultProvider(getNetwork(liquidityTokens[0].chainId)),
  ) : Promise<{
    fee: BigintIsh
    owner: string
  }[]> {
    const multicall = new Contract(MULTICALL_ADDRESS[liquidityTokens[0].chainId], MULTICALL_ABI, provider)
    const factoryContract = new Contract(FACTORY_ADDRESS[liquidityTokens[0].chainId], IDXswapFactory.abi, provider);
    const liquidityTokenContract = new Contract(liquidityTokens[0].address, IDXswapPair.abi, provider)
    let calls = []
    calls.push({
      address: factoryContract.address,
      callData: factoryContract.interface.encodeFunctionData(factoryContract.interface.getFunction('feeToSetter()'))
    })
    for (let tokenPairsIndex = 0; tokenPairsIndex < liquidityTokens.length; tokenPairsIndex++) {
      calls.push({
        address: liquidityTokens[tokenPairsIndex].address,
        callData: liquidityTokenContract.interface.encodeFunctionData(liquidityTokenContract.interface.getFunction('swapFee()'))
      })
    }
    const result = await multicall.aggregate(calls.map(call => [call.address, call.callData]))
    const owner = factoryContract.interface.decodeFunctionResult(
      factoryContract.interface.getFunction('feeToSetter()'),
      result.returnData[0]
    )[0];
    let fees = [];
    for (let resultIndex = 1; resultIndex < result.returnData.length; resultIndex++) {
      fees.push({
        fee: JSBI.BigInt(liquidityTokenContract.interface.decodeFunctionResult(
          liquidityTokenContract.interface.getFunction('swapFee()'),
          result.returnData[resultIndex]
        )[0]),
        owner
      })
    }
    return fees
  }
  
  /**
   * Fetches swap fee information of all registered token pairs from factory
   * @param chainId the chainId of the network to fecth the swap fees
   * @param swapFeesCache a cache of already fetched fees to be skiped
   * @param provider the provider to use to fetch the data
   */
  public static async fetchAllSwapFees(
    chainId: ChainId,
    swapFeesCache: {
      [key: string] : {
        fee: BigintIsh
        owner: string
      }
    } = {},
    provider = getDefaultProvider(getNetwork(chainId))
  ) : Promise<{
    [key: string] : {
      fee: BigintIsh
      owner: string
    }
  }> {
    const multicall = new Contract(MULTICALL_ADDRESS[chainId], MULTICALL_ABI, provider)
    const factoryContract = new Contract(FACTORY_ADDRESS[chainId], IDXswapFactory.abi, provider);
    const allPairsLength = await factoryContract.allPairsLength()
    let allSwapPairs: {
      [key: string] : {
        fee: BigintIsh
        owner: string
      }
    } = {}
    
    // Get first token pairs from cache
    let tokenPairsCache = Object.keys(swapFeesCache);
    let tokenPairsToFetch: Token[] = []
    for (let tokenPaisCacheIndex = 0; tokenPaisCacheIndex < tokenPairsCache.length; tokenPaisCacheIndex++) {
        allSwapPairs[tokenPairsCache[tokenPaisCacheIndex]] = {
          fee: swapFeesCache[tokenPairsCache[tokenPaisCacheIndex]].fee,
          owner: swapFeesCache[tokenPairsCache[tokenPaisCacheIndex]].owner
        }
    }
    
    // Get rest of the token pairs that are not cached
    let calls = []
    for (let pairIndex = tokenPairsCache.length; pairIndex < allPairsLength; pairIndex++)
      calls.push({
        address: factoryContract.address,
        callData: factoryContract.interface.encodeFunctionData(factoryContract.interface.getFunction('allPairs(uint)'), [pairIndex])
      })
    const result = await multicall.aggregate(calls.map(call => [call.address, call.callData]))
    for (let resultIndex = 0; resultIndex < result.returnData.length; resultIndex++) {
      const tokenPairAddress = factoryContract.interface.decodeFunctionResult(
        factoryContract.interface.getFunction('allPairs(uint256)'),
        result.returnData[resultIndex]
      )[0]
      tokenPairsToFetch.push(new Token(chainId, tokenPairAddress, 18, 'DXS', 'DXswap'))
    }
    
    // Fetch the pairs that we dont have the fee and owner
    const swapFeesFetched = await this.fetchSwapFees(tokenPairsToFetch, provider);
    for (let tokenPairsToFetchIndex = 0; tokenPairsToFetchIndex < tokenPairsToFetch.length; tokenPairsToFetchIndex++)
      allSwapPairs[tokenPairsToFetch[tokenPairsToFetchIndex].address] = swapFeesFetched[tokenPairsToFetchIndex]
    return allSwapPairs
  }
  
  /**
   * Fetches protocol fee information from the token pair factory
   * @param chainId the chainId of the network to fecth the protocol fee
   * @param provider the provider to use to fetch the data
   */
  public static async fetchProtocolFee(
    chainId: ChainId,
    provider = getDefaultProvider(getNetwork(chainId)),
  ) : Promise<{
    feeDenominator: BigintIsh,
    feeReceiver: string
  }> {
    const factoryContract = await new Contract(
      FACTORY_ADDRESS[chainId],
      IDXswapFactory.abi,
      provider
    );
    const feeDenominator = await factoryContract.protocolFeeDenominator()
    const feeReceiver = await factoryContract.feeTo()
    return { feeDenominator, feeReceiver }
  }
    
}
