import { finalize, map, Observable, type Subscription } from "rxjs";

import { ReconnectingTransport } from "@/ApiClient/ReconnectingTransport";
import { WebSocketTransport } from "@/ApiClient/WebSocketTransport";
import { AssetsResponse } from "@/dto/Assets";
import type { Quote } from "@/dto/Quote";
import { QuoteRequest } from "@/dto/QuoteRequest";
import { TrackTradeRequest } from "@/dto/TrackTradeRequest";
import { TradeStatus } from "@/dto/TradeStatus";
import { TransactionRequest } from "@/dto/TransactionRequest";
import { TransactionResponse } from "@/dto/TransactionResponse";
import { QuoteEvent } from "@/dto/QuoteEvent";
import { ApiClient } from "../ApiClient/ApiClient";
import type { IApiClient } from "../ApiClient/ApiClient.types";
import { Timer } from "../helpers/timer/Timer";
import type { ITimer } from "../helpers/timer/Timer.types";
import type { IOmnistonDependencies } from "./Omniston.types";
import { QuoteResponseController } from "./QuoteResponseController";
import {
  METHOD_ASSET_QUERY,
  METHOD_BUILD_TRANSFER,
  METHOD_QUOTE,
  METHOD_QUOTE_EVENT,
  METHOD_QUOTE_UNSUBSCRIBE,
  METHOD_TRACK_TRADE,
  METHOD_TRACK_TRADE_EVENT,
  METHOD_TRACK_TRADE_UNSUBSCRIBE,
} from "@/omniston/rpcConstants";

/**
 * The main class for the Omniston Trader SDK.
 *
 * Represents a service to perform Trader operations. Supports RequestForQuote, BuildTransaction, and TrackTrade operations.
 *
 * The class is closeable - use {@link Omniston.close} to close the underlying WebSocket connection.
 */
export class Omniston {
  private readonly apiClient: IApiClient;
  private timer: ITimer = new Timer();

  /**
   * Constructor.
   * @param dependencies {@see IOmnistonDependencies}
   */
  constructor(dependencies: IOmnistonDependencies) {
    const apiUrl = dependencies.apiUrl;
    this.apiClient =
      dependencies.client ??
      new ApiClient(
        new ReconnectingTransport({
          factory: () => new WebSocketTransport(apiUrl),
          timer: this.timer,
        }),
      );
  }

  /**
   * Request for quote.
   *
   * The server sends the stream of quotes in response, so that each next quote overrides previous one.
   * This may occur either because the newer quote has better terms or because the older has expired.
   *
   * If there are no resolvers providing quotes after an old quote has expired, {@constant null} is sent to the Observable.
   *
   * @param request Request for quote. {@see QuoteRequest}
   * @returns Observable representing the stream of quote updates.
   * The request to the API server is made after subscribing to the Observable.
   * The client is responsible for unsubscribing from the Observable when not interested in further updates
   * (either after starting the trade or when cancelling the request).
   */
  public readonly requestForQuote = unwrapObservable(this._requestForQuote);

  private async _requestForQuote(
    request: QuoteRequest,
  ): Promise<Observable<Quote | null>> {
    await this.apiClient.ensureConnection();

    const subscriptionId = (await this.apiClient.send(
      METHOD_QUOTE,
      QuoteRequest.toJSON(request),
    )) as number;

    const quoteEvents = this.apiClient
      .readStream(METHOD_QUOTE_EVENT, subscriptionId)
      .pipe(map(QuoteEvent.fromJSON));

    const quoteController = new QuoteResponseController({
      timer: this.timer,
      quoteEvents,
    });

    return quoteController.quote.pipe(
      finalize(() =>
        this.unsubscribeFromStream(METHOD_QUOTE_UNSUBSCRIBE, subscriptionId),
      ),
    );
  }

  /**
   * A request to generate unsigned transfer to initiate the trade.
   *
   * @param request {@see TransactionRequest}
   * @returns {@see TransactionResponse}
   */
  async buildTransfer(
    request: TransactionRequest,
  ): Promise<TransactionResponse> {
    await this.apiClient.ensureConnection();

    const response = await this.apiClient.send(
      METHOD_BUILD_TRANSFER,
      TransactionRequest.toJSON(request),
    );

    return TransactionResponse.fromJSON(response);
  }

  /**
   * Request to track settling of the trade.
   *
   * The server immediately sends current status in response and then all updates to the status.
   *
   * The server only closes the stream in case of errors. If the stream is interrupted or closed by the server,
   * the client might reconnect to get further updates.
   *
   * @param request Status tracking request. {@see TrackTradeRequest}
   * @returns Observable representing the stream of trade status updates.
   * The request to the API server is made after subscribing to the Observable.
   * The client is responsible for unsubscribing from the Observable when not interested in further updates.
   */
  public trackTrade = unwrapObservable(this._trackTrade);

  private async _trackTrade(
    request: TrackTradeRequest,
  ): Promise<Observable<TradeStatus>> {
    await this.apiClient.ensureConnection();

    const subscriptionId = (await this.apiClient.send(
      METHOD_TRACK_TRADE,
      TrackTradeRequest.toJSON(request),
    )) as number;

    return this.apiClient
      .readStream(METHOD_TRACK_TRADE_EVENT, subscriptionId)
      .pipe(
        map((status) => TradeStatus.fromJSON(status)),
        finalize(() =>
          this.unsubscribeFromStream(
            METHOD_TRACK_TRADE_UNSUBSCRIBE,
            subscriptionId,
          ),
        ),
      );
  }

  /**
   * Get a list of supported assets information.
   */
  async assetList(): Promise<AssetsResponse> {
    await this.apiClient.ensureConnection();

    const response = await this.apiClient.send(METHOD_ASSET_QUERY, {});

    return AssetsResponse.fromJSON(response);
  }

  /**
   * Closes the underlying connection, no longer accepting requests.
   */
  public close() {
    this.apiClient.close();
  }

  private async unsubscribeFromStream(method: string, subscriptionId: number) {
    const result = await this.apiClient.unsubscribeFromStream(
      method,
      subscriptionId,
    );
    if (result !== true) {
      console.warn(
        `Failed to unsubscribe with method ${method} and subscription ID ${subscriptionId}. Server returned ${result}`,
      );
    }
  }
}

/**
 * Helper to unwrap return type from Promise<Observable<T>> to Observable<T>
 */
function unwrapObservable<TArgs extends Array<unknown>, TReturn>(
  originalMethod: (
    this: Omniston,
    ...args: TArgs
  ) => Promise<Observable<TReturn>>,
) {
  return function (this: Omniston, ...args: TArgs) {
    return new Observable<TReturn>((subscriber) => {
      const result = originalMethod.apply(this, args);

      let unsubscribed = false;
      let innerSubscription: Subscription | undefined;

      result.then(
        (inner) => {
          innerSubscription = inner.subscribe(subscriber);

          if (unsubscribed) {
            innerSubscription.unsubscribe();
          }
        },
        (err) => {
          subscriber.error(err);
        },
      );

      return () => {
        unsubscribed = true;
        innerSubscription?.unsubscribe();
      };
    });
  };
}