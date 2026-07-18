import Capacitor
import Foundation
import PinnedTransportCore

@objc(PinnedTransportPlugin)
final class PinnedTransportPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PinnedTransportPlugin"
    let jsName = "PinnedTransport"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openWebSocket", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeWebSocket", returnType: CAPPluginReturnPromise),
    ]

    private let stateLock = NSLock()
    private var requests: [String: PinnedRequestOperation] = [:]
    private var webSockets: [String: PinnedWebSocketConnection] = [:]

    @objc func request(_ call: CAPPluginCall) {
        do {
            let requestID = try requiredIdentifier(call, key: "requestId")
            let url = try requiredURL(call, key: "url")
            let fingerprint = try requiredString(call, key: "fingerprint")
            let method = try requiredString(call, key: "method").uppercased()
            let headers = try stringDictionary(call.getObject("headers") ?? [:], field: "headers")
            let body = call.getString("body").map { Data($0.utf8) }
            let policy = try PinnedTrustPolicy(
                url: url,
                requiredScheme: "https",
                fingerprint: fingerprint
            )

            let newOperation = PinnedRequestOperation(
                requestID: requestID,
                url: url,
                method: method,
                headers: headers,
                body: body,
                policy: policy
            ) { [weak self] operation, result in
                guard let self else { return }
                self.removeRequest(requestID, matching: operation)
                DispatchQueue.main.async {
                    switch result {
                    case let .success(response):
                        call.resolve([
                            "status": response.status,
                            "headers": response.headers,
                            "body": response.body,
                        ])
                    case let .failure(error):
                        call.reject(error.localizedDescription, transportErrorCode(error), error)
                    }
                }
            }
            guard insertRequest(newOperation, id: requestID) else {
                newOperation.discard()
                throw NativeTransportError.duplicateIdentifier("requestId", requestID)
            }
            newOperation.start()
        } catch {
            call.reject(error.localizedDescription, transportErrorCode(error), error)
        }
    }

    @objc func cancelRequest(_ call: CAPPluginCall) {
        do {
            let requestID = try requiredIdentifier(call, key: "requestId")
            request(withID: requestID)?.cancel()
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, transportErrorCode(error), error)
        }
    }

    @objc func openWebSocket(_ call: CAPPluginCall) {
        do {
            let connectionID = try requiredIdentifier(call, key: "connectionId")
            let url = try requiredURL(call, key: "url")
            let fingerprint = try requiredString(call, key: "fingerprint")
            let protocols = try stringArray(call.getArray("protocols") ?? [], field: "protocols")
            let policy = try PinnedTrustPolicy(
                url: url,
                requiredScheme: "wss",
                fingerprint: fingerprint
            )

            let connection = PinnedWebSocketConnection(
                connectionID: connectionID,
                url: url,
                protocols: protocols,
                policy: policy
            ) { [weak self] source, event in
                self?.handleWebSocketEvent(event, source: source)
            }

            guard insertWebSocket(connection, id: connectionID) else {
                connection.discard()
                throw NativeTransportError.duplicateIdentifier("connectionId", connectionID)
            }

            connection.start()
            call.resolve(["connectionId": connectionID])
        } catch {
            call.reject(error.localizedDescription, transportErrorCode(error), error)
        }
    }

    @objc func closeWebSocket(_ call: CAPPluginCall) {
        do {
            let connectionID = try requiredIdentifier(call, key: "connectionId")
            takeWebSocket(connectionID)?.close()
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, transportErrorCode(error), error)
        }
    }

    deinit {
        stateLock.lock()
        let activeRequests = Array(requests.values)
        let activeWebSockets = Array(webSockets.values)
        requests.removeAll()
        webSockets.removeAll()
        stateLock.unlock()

        activeRequests.forEach { $0.cancel() }
        activeWebSockets.forEach { $0.close() }
    }

    private func handleWebSocketEvent(
        _ event: PinnedWebSocketEvent,
        source: PinnedWebSocketConnection
    ) {
        if event.isTerminal {
            removeWebSocket(event.connectionID, matching: source)
        }
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("streamEvent", data: event.payload)
        }
    }

    private func requiredIdentifier(_ call: CAPPluginCall, key: String) throws -> String {
        let value = try requiredString(call, key: key)
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            throw NativeTransportError.invalidField(key)
        }
        return value
    }

    private func requiredString(_ call: CAPPluginCall, key: String) throws -> String {
        guard let value = call.getString(key), !value.isEmpty else {
            throw NativeTransportError.invalidField(key)
        }
        return value
    }

    private func requiredURL(_ call: CAPPluginCall, key: String) throws -> URL {
        let value = try requiredString(call, key: key)
        guard let url = URL(string: value), url.user == nil, url.password == nil else {
            throw NativeTransportError.invalidField(key)
        }
        return url
    }

    private func stringDictionary(_ object: JSObject, field: String) throws -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in object {
            guard let string = value as? String else {
                throw NativeTransportError.invalidField(field)
            }
            result[key] = string
        }
        return result
    }

    private func stringArray(_ values: JSArray, field: String) throws -> [String] {
        guard let strings = values as? [String],
              strings.allSatisfy({ !$0.isEmpty })
        else {
            throw NativeTransportError.invalidField(field)
        }
        return strings
    }

    private func insertRequest(_ operation: PinnedRequestOperation, id: String) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard requests[id] == nil else { return false }
        requests[id] = operation
        return true
    }

    private func request(withID id: String) -> PinnedRequestOperation? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return requests[id]
    }

    private func removeRequest(_ id: String, matching operation: PinnedRequestOperation) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard requests[id] === operation else { return }
        requests.removeValue(forKey: id)
    }

    private func insertWebSocket(_ connection: PinnedWebSocketConnection, id: String) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard webSockets[id] == nil else { return false }
        webSockets[id] = connection
        return true
    }

    private func takeWebSocket(_ id: String) -> PinnedWebSocketConnection? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return webSockets.removeValue(forKey: id)
    }

    private func removeWebSocket(_ id: String, matching connection: PinnedWebSocketConnection) {
        stateLock.lock()
        if webSockets[id] === connection {
            webSockets.removeValue(forKey: id)
        }
        stateLock.unlock()
    }
}

private struct PinnedResponse {
    let status: Int
    let headers: [String: String]
    let body: String
}

private final class PinnedRequestOperation {
    private let stateLock = NSLock()
    private let completion: (PinnedRequestOperation, Result<PinnedResponse, Error>) -> Void
    private let delegate: PinnedSessionDelegate
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var policyViolation: Error?
    private var suppressCompletion = false

    init(
        requestID: String,
        url: URL,
        method: String,
        headers: [String: String],
        body: Data?,
        policy: PinnedTrustPolicy,
        completion: @escaping (PinnedRequestOperation, Result<PinnedResponse, Error>) -> Void
    ) {
        self.completion = completion
        delegate = PinnedSessionDelegate(policy: policy)
        delegate.onPolicyViolation = { [weak self] error in
            self?.recordPolicyViolation(error)
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }

        task = session.dataTask(with: request) { [weak self] data, response, error in
            self?.finish(data: data, response: response, error: error)
        }
        task?.taskDescription = requestID
    }

    func start() {
        task?.resume()
    }

    func cancel() {
        task?.cancel()
        session.invalidateAndCancel()
    }

    func discard() {
        stateLock.lock()
        suppressCompletion = true
        stateLock.unlock()
        cancel()
    }

    private func recordPolicyViolation(_ error: Error) {
        stateLock.lock()
        if policyViolation == nil {
            policyViolation = error
        }
        stateLock.unlock()
    }

    private func finish(data: Data?, response: URLResponse?, error: Error?) {
        stateLock.lock()
        let trustError = policyViolation
        let shouldSuppressCompletion = suppressCompletion
        stateLock.unlock()

        defer {
            task = nil
            session.finishTasksAndInvalidate()
        }

        guard !shouldSuppressCompletion else { return }

        if let trustError {
            completion(self, .failure(trustError))
            return
        }
        if let error {
            completion(self, .failure(error))
            return
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            completion(self, .failure(NativeTransportError.invalidHTTPResponse))
            return
        }

        var headers: [String: String] = [:]
        for (key, value) in httpResponse.allHeaderFields {
            headers[String(describing: key)] = String(describing: value)
        }
        let bodyData = data ?? Data()
        let body = String(data: bodyData, encoding: .utf8) ?? bodyData.base64EncodedString()
        completion(self, .success(PinnedResponse(status: httpResponse.statusCode, headers: headers, body: body)))
    }
}

private final class PinnedWebSocketConnection {
    let connectionID: String

    private let stateLock = NSLock()
    private let eventHandler: (PinnedWebSocketConnection, PinnedWebSocketEvent) -> Void
    private let delegate: PinnedSessionDelegate
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private var terminal = false

    init(
        connectionID: String,
        url: URL,
        protocols: [String],
        policy: PinnedTrustPolicy,
        eventHandler: @escaping (PinnedWebSocketConnection, PinnedWebSocketEvent) -> Void
    ) {
        self.connectionID = connectionID
        self.eventHandler = eventHandler
        delegate = PinnedSessionDelegate(policy: policy)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        task = session.webSocketTask(with: url, protocols: protocols)

        delegate.onPolicyViolation = { [weak self] error in
            self?.fail(error)
        }
        delegate.onWebSocketOpen = { [weak self] _ in
            self?.opened()
        }
        delegate.onWebSocketClose = { [weak self] closeCode, reason in
            self?.closed(code: Int(closeCode.rawValue), reason: reason)
        }
    }

    func start() {
        task.resume()
        receiveNextMessage()
    }

    func close() {
        guard markTerminal() else { return }
        task.cancel(with: .normalClosure, reason: nil)
        session.finishTasksAndInvalidate()
        eventHandler(self, .close(connectionID: connectionID, code: 1000, reason: nil))
    }

    func discard() {
        guard markTerminal() else { return }
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    private func opened() {
        guard !isTerminal else { return }
        eventHandler(self, .open(connectionID: connectionID))
    }

    private func receiveNextMessage() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                guard !self.isTerminal else { return }
                switch message {
                case let .string(value):
                    self.eventHandler(self, .message(connectionID: self.connectionID, data: value))
                case let .data(value):
                    let data = String(data: value, encoding: .utf8) ?? value.base64EncodedString()
                    self.eventHandler(self, .message(connectionID: self.connectionID, data: data))
                @unknown default:
                    self.fail(NativeTransportError.unsupportedWebSocketMessage)
                    return
                }
                self.receiveNextMessage()
            case let .failure(error):
                self.fail(error)
            }
        }
    }

    private func fail(_ error: Error) {
        guard markTerminal() else { return }
        task.cancel(with: .policyViolation, reason: nil)
        session.invalidateAndCancel()
        eventHandler(
            self,
            .error(
                connectionID: connectionID,
                code: transportErrorCode(error),
                reason: error.localizedDescription
            )
        )
    }

    private func closed(code: Int, reason: Data?) {
        guard markTerminal() else { return }
        session.finishTasksAndInvalidate()
        let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) }
        eventHandler(self, .close(connectionID: connectionID, code: code, reason: reasonText))
    }

    private var isTerminal: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return terminal
    }

    private func markTerminal() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !terminal else { return false }
        terminal = true
        return true
    }
}

private enum PinnedWebSocketEvent {
    case open(connectionID: String)
    case message(connectionID: String, data: String)
    case close(connectionID: String, code: Int, reason: String?)
    case error(connectionID: String, code: String, reason: String)

    var connectionID: String {
        switch self {
        case let .open(connectionID),
             let .message(connectionID, _),
             let .close(connectionID, _, _),
             let .error(connectionID, _, _):
            return connectionID
        }
    }

    var isTerminal: Bool {
        switch self {
        case .close, .error:
            return true
        case .open, .message:
            return false
        }
    }

    var payload: [String: Any] {
        switch self {
        case let .open(connectionID):
            return ["connectionId": connectionID, "type": "open"]
        case let .message(connectionID, data):
            return ["connectionId": connectionID, "type": "message", "data": data]
        case let .close(connectionID, code, reason):
            var value: [String: Any] = [
                "connectionId": connectionID,
                "type": "close",
                "code": code,
            ]
            if let reason {
                value["reason"] = reason
            }
            return value
        case let .error(connectionID, code, reason):
            return [
                "connectionId": connectionID,
                "type": "error",
                "code": code,
                "reason": reason,
            ]
        }
    }
}

private enum NativeTransportError: Error, LocalizedError {
    case invalidField(String)
    case duplicateIdentifier(String, String)
    case invalidHTTPResponse
    case unsupportedWebSocketMessage

    var errorDescription: String? {
        switch self {
        case let .invalidField(field):
            return "Field \(field) is missing or invalid."
        case let .duplicateIdentifier(field, value):
            return "An operation with \(field) \(value) is already active."
        case .invalidHTTPResponse:
            return "The pinned request did not return an HTTP response."
        case .unsupportedWebSocketMessage:
            return "The server sent an unsupported WebSocket message."
        }
    }
}

private func transportErrorCode(_ error: Error) -> String {
    if let pinningError = error as? PinnedTransportError {
        switch pinningError {
        case .invalidFingerprint:
            return "TLS_PIN_REQUIRED"
        case .fingerprintMismatch:
            return "CERTIFICATE_PIN_MISMATCH"
        case .hostMismatch:
            return "TLS_HOST_MISMATCH"
        case .redirectRejected:
            return "TLS_REDIRECT_REJECTED"
        case .missingServerTrust, .missingLeafCertificate:
            return "TLS_TRUST_FAILED"
        case .invalidURL, .invalidScheme, .missingHost:
            return "INVALID_OPTIONS"
        }
    }

    if let nativeError = error as? NativeTransportError {
        switch nativeError {
        case let .invalidField(field) where field == "fingerprint":
            return "TLS_PIN_REQUIRED"
        case .duplicateIdentifier:
            return "DUPLICATE_OPERATION"
        case .invalidField:
            return "INVALID_OPTIONS"
        case .invalidHTTPResponse:
            return "INVALID_RESPONSE"
        case .unsupportedWebSocketMessage:
            return "UNSUPPORTED_MESSAGE"
        }
    }

    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
        return "REQUEST_CANCELLED"
    }
    return "TRANSPORT_ERROR"
}
