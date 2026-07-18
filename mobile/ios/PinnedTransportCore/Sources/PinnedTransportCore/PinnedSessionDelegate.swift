import Foundation

public final class PinnedSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionWebSocketDelegate, @unchecked Sendable {
    public let policy: PinnedTrustPolicy

    /// Called when a challenge or redirect fails the pin policy. URLSession
    /// will also finish the affected task with an error.
    public var onPolicyViolation: (@Sendable (Error) -> Void)?
    public var onWebSocketOpen: (@Sendable (String?) -> Void)?
    public var onWebSocketClose: (@Sendable (URLSessionWebSocketTask.CloseCode, Data?) -> Void)?

    public init(policy: PinnedTrustPolicy) {
        self.policy = policy
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler: completionHandler)
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler: completionHandler)
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard policy.permitsRedirect(to: request.url) else {
            onPolicyViolation?(PinnedTransportError.redirectRejected)
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        onWebSocketOpen?(`protocol`)
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        onWebSocketClose?(closeCode, reason)
    }

    private func handle(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        guard let serverTrust = challenge.protectionSpace.serverTrust else {
            let error = PinnedTransportError.missingServerTrust
            onPolicyViolation?(error)
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        do {
            let credential = try policy.credential(
                for: serverTrust,
                challengeHost: challenge.protectionSpace.host,
                challengePort: challenge.protectionSpace.port
            )
            completionHandler(.useCredential, credential)
        } catch {
            onPolicyViolation?(error)
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
