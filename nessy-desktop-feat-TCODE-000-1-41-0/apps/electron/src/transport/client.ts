/** Electron transport client with a non-secret workspace ID accessor. */
import {
  WsRpcClient as CoreWsRpcClient,
  type WsRpcClientOptions,
} from '@nessy-agent/server-core/transport'

export class WsRpcClient extends CoreWsRpcClient {
  private readonly routedWorkspaceId: string | undefined

  constructor(url: string, options?: WsRpcClientOptions) {
    super(url, options)
    this.routedWorkspaceId = options?.workspaceId
  }

  getWorkspaceId(): string | undefined {
    return this.routedWorkspaceId
  }
}

export {
  type WsRpcClientOptions,
  type TransportMode,
  type TransportConnectionStatus,
  type TransportConnectionErrorKind,
  type TransportConnectionError,
  type TransportCloseInfo,
  type TransportConnectionState,
} from '@nessy-agent/server-core/transport'
