import { ContractAddresses } from '@0x/contract-addresses';
import { IZeroExContract } from '@0x/contract-wrappers';
import {
    encodeAffiliateFeeTransformerData,
    encodeFillQuoteTransformerData,
    encodePayTakerTransformerData,
    encodeWethTransformerData,
    ETH_TOKEN_ADDRESS,
    FillQuoteTransformerSide,
    findTransformerNonce,
} from '@0x/order-utils';
import { BigNumber, providerUtils } from '@0x/utils';
import { SupportedProvider, ZeroExProvider } from '@0x/web3-wrapper';
import * as _ from 'lodash';

import { constants } from '../constants';
import {
    CalldataInfo,
    ExchangeProxyContractOpts,
    MarketBuySwapQuote,
    MarketOperation,
    MarketSellSwapQuote,
    SwapQuote,
    SwapQuoteConsumerBase,
    SwapQuoteConsumerOpts,
    SwapQuoteExecutionOpts,
    SwapQuoteGetOutputOpts,
} from '../types';
import { assert } from '../utils/assert';
import { getTokenFromAssetData } from '../utils/utils';

// tslint:disable-next-line:custom-no-magic-numbers
const MAX_UINT256 = new BigNumber(2).pow(256).minus(1);
const { NULL_ADDRESS } = constants;

export class ExchangeProxySwapQuoteConsumer implements SwapQuoteConsumerBase {
    public readonly provider: ZeroExProvider;
    public readonly chainId: number;
    public readonly transformerNonces: {
        wethTransformer: number;
        payTakerTransformer: number;
        fillQuoteTransformer: number;
        affiliateFeeTransformer: number;
    };

    private readonly _exchangeProxy: IZeroExContract;

    constructor(
        supportedProvider: SupportedProvider,
        public readonly contractAddresses: ContractAddresses,
        options: Partial<SwapQuoteConsumerOpts> = {},
    ) {
        const { chainId } = _.merge({}, constants.DEFAULT_SWAP_QUOTER_OPTS, options);
        assert.isNumber('chainId', chainId);
        const provider = providerUtils.standardizeOrThrow(supportedProvider);
        this.provider = provider;
        this.chainId = chainId;
        this.contractAddresses = contractAddresses;
        this._exchangeProxy = new IZeroExContract(contractAddresses.exchangeProxy, supportedProvider);
        this.transformerNonces = {
            wethTransformer: findTransformerNonce(
                contractAddresses.transformers.wethTransformer,
                contractAddresses.exchangeProxyTransformerDeployer,
            ),
            payTakerTransformer: findTransformerNonce(
                contractAddresses.transformers.payTakerTransformer,
                contractAddresses.exchangeProxyTransformerDeployer,
            ),
            fillQuoteTransformer: findTransformerNonce(
                contractAddresses.transformers.fillQuoteTransformer,
                contractAddresses.exchangeProxyTransformerDeployer,
            ),
            affiliateFeeTransformer: findTransformerNonce(
                contractAddresses.transformers.affiliateFeeTransformer,
                contractAddresses.exchangeProxyTransformerDeployer,
            ),
        };
    }

    public async getCalldataOrThrowAsync(
        quote: MarketBuySwapQuote | MarketSellSwapQuote,
        opts: Partial<SwapQuoteGetOutputOpts> = {},
    ): Promise<CalldataInfo> {
        assert.isValidSwapQuote('quote', quote);
        // tslint:disable-next-line:no-object-literal-type-assertion
        const { refundReceiver, affiliateFee, isFromETH, isToETH } = {
            ...constants.DEFAULT_EXCHANGE_PROXY_EXTENSION_CONTRACT_OPTS,
            ...opts.extensionContractOpts,
        } as ExchangeProxyContractOpts;

        const sellToken = getTokenFromAssetData(quote.takerAssetData);
        const buyToken = getTokenFromAssetData(quote.makerAssetData);
        const sellAmount = quote.worstCaseQuoteInfo.totalTakerAssetAmount;

        // Build up the transforms.
        const transforms = [];
        if (isFromETH) {
            // Create a WETH wrapper if coming from ETH.
            transforms.push({
                deploymentNonce: this.transformerNonces.wethTransformer,
                data: encodeWethTransformerData({
                    token: ETH_TOKEN_ADDRESS,
                    amount: sellAmount,
                }),
            });
        }

        const intermediateToken = quote.isTwoHop ? getTokenFromAssetData(quote.orders[0].makerAssetData) : NULL_ADDRESS;
        // This transformer will fill the quote.
        if (quote.isTwoHop) {
            const [firstHopOrder, secondHopOrder] = quote.orders;
            transforms.push({
                deploymentNonce: this.transformerNonces.fillQuoteTransformer,
                data: encodeFillQuoteTransformerData({
                    sellToken,
                    buyToken: intermediateToken,
                    side: FillQuoteTransformerSide.Sell,
                    refundReceiver: refundReceiver || NULL_ADDRESS,
                    fillAmount: firstHopOrder.takerAssetAmount,
                    maxOrderFillAmounts: [],
                    rfqtTakerAddress: NULL_ADDRESS,
                    orders: [firstHopOrder],
                    signatures: [firstHopOrder.signature],
                }),
            });
            transforms.push({
                deploymentNonce: this.transformerNonces.fillQuoteTransformer,
                data: encodeFillQuoteTransformerData({
                    buyToken,
                    sellToken: intermediateToken,
                    refundReceiver: refundReceiver || NULL_ADDRESS,
                    side: FillQuoteTransformerSide.Sell,
                    fillAmount: MAX_UINT256,
                    maxOrderFillAmounts: [],
                    rfqtTakerAddress: NULL_ADDRESS,
                    orders: [secondHopOrder],
                    signatures: [secondHopOrder.signature],
                }),
            });
        } else {
            transforms.push({
                deploymentNonce: this.transformerNonces.fillQuoteTransformer,
                data: encodeFillQuoteTransformerData({
                    sellToken,
                    buyToken,
                    refundReceiver: refundReceiver || NULL_ADDRESS,
                    side: isBuyQuote(quote) ? FillQuoteTransformerSide.Buy : FillQuoteTransformerSide.Sell,
                    fillAmount: isBuyQuote(quote) ? quote.makerAssetFillAmount : quote.takerAssetFillAmount,
                    maxOrderFillAmounts: [],
                    rfqtTakerAddress: NULL_ADDRESS,
                    orders: quote.orders,
                    signatures: quote.orders.map(o => o.signature),
                }),
            });
        }

        if (isToETH) {
            // Create a WETH unwrapper if going to ETH.
            transforms.push({
                deploymentNonce: this.transformerNonces.wethTransformer,
                data: encodeWethTransformerData({
                    token: this.contractAddresses.etherToken,
                    amount: MAX_UINT256,
                }),
            });
        }

        // This transformer pays affiliate fees.
        const { buyTokenFeeAmount, sellTokenFeeAmount, recipient: feeRecipient } = affiliateFee;

        if (buyTokenFeeAmount.isGreaterThan(0) && feeRecipient !== NULL_ADDRESS) {
            transforms.push({
                deploymentNonce: this.transformerNonces.affiliateFeeTransformer,
                data: encodeAffiliateFeeTransformerData({
                    fees: [
                        {
                            token: isToETH ? ETH_TOKEN_ADDRESS : buyToken,
                            amount: buyTokenFeeAmount,
                            recipient: feeRecipient,
                        },
                    ],
                }),
            });
        }

        if (sellTokenFeeAmount.isGreaterThan(0) && feeRecipient !== NULL_ADDRESS) {
            throw new Error('Affiliate fees denominated in sell token are not yet supported');
        }

        // The final transformer will send all funds to the taker.
        transforms.push({
            deploymentNonce: this.transformerNonces.payTakerTransformer,
            data: encodePayTakerTransformerData({
                tokens: [sellToken, buyToken, ETH_TOKEN_ADDRESS].concat(quote.isTwoHop ? intermediateToken : []),
                amounts: [],
            }),
        });

        const minBuyAmount = BigNumber.max(0, quote.worstCaseQuoteInfo.makerAssetAmount.minus(buyTokenFeeAmount));
        const calldataHexString = this._exchangeProxy
            .transformERC20(
                isFromETH ? ETH_TOKEN_ADDRESS : sellToken,
                isToETH ? ETH_TOKEN_ADDRESS : buyToken,
                sellAmount,
                minBuyAmount,
                transforms,
            )
            .getABIEncodedTransactionData();

        let ethAmount = quote.worstCaseQuoteInfo.protocolFeeInWeiAmount;
        if (isFromETH) {
            ethAmount = ethAmount.plus(sellAmount);
        }

        return {
            calldataHexString,
            ethAmount,
            toAddress: this._exchangeProxy.address,
            allowanceTarget: this.contractAddresses.exchangeProxyAllowanceTarget,
        };
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async executeSwapQuoteOrThrowAsync(
        _quote: SwapQuote,
        _opts: Partial<SwapQuoteExecutionOpts>,
    ): Promise<string> {
        throw new Error('Execution not supported for Exchange Proxy quotes');
    }
}

function isBuyQuote(quote: SwapQuote): quote is MarketBuySwapQuote {
    return quote.type === MarketOperation.Buy;
}
