#if os(macOS)
import CryptoKit
import Foundation
import Network
import Security
import XCTest
@testable import PinnedTransportCore

final class PinnedTransportNetworkIntegrationTests: XCTestCase {
    func testRESTUsesSharedDelegateForMatchingAndMismatchingPins() throws {
        let identity = try LocalTLSIdentity()
        let server = try LocalTLSServer(mode: .http, identity: identity)
        defer { server.stop() }

        let url = try XCTUnwrap(server.url(scheme: "https", path: "/health"))
        let rejected = performRESTRequest(url: url, fingerprint: Self.invalidFingerprint)
        XCTAssertNil(rejected.status)
        XCTAssertNotNil(rejected.error)
        XCTAssertEqual(rejected.policyViolation as? PinnedTransportError, .fingerprintMismatch)

        let accepted = performRESTRequest(url: url, fingerprint: identity.fingerprint)
        XCTAssertEqual(accepted.status, 200)
        XCTAssertEqual(accepted.body, "ok")
        XCTAssertNil(accepted.error)
        XCTAssertNil(accepted.policyViolation)
    }

    func testWebSocketUsesSharedDelegateForMatchingAndMismatchingPins() throws {
        let identity = try LocalTLSIdentity()
        let server = try LocalTLSServer(mode: .webSocket, identity: identity)
        defer { server.stop() }

        let url = try XCTUnwrap(server.url(scheme: "wss", path: "/ws"))
        assertWebSocketRejectsMismatchingPin(url: url)
        assertWebSocketAcceptsMatchingPin(url: url, fingerprint: identity.fingerprint)
    }

    private func performRESTRequest(url: URL, fingerprint: String) -> RESTOutcome {
        let completed = expectation(description: "REST request completed")
        let outcome = LockedBox(RESTOutcome())

        do {
            let policy = try PinnedTrustPolicy(
                url: url,
                requiredScheme: "https",
                fingerprint: fingerprint
            )
            let delegate = PinnedSessionDelegate(policy: policy)
            delegate.onPolicyViolation = { error in
                outcome.update { $0.policyViolation = error }
            }
            let session = URLSession(
                configuration: .ephemeral,
                delegate: delegate,
                delegateQueue: nil
            )
            session.dataTask(with: url) { data, response, error in
                outcome.update {
                    $0.status = (response as? HTTPURLResponse)?.statusCode
                    $0.body = data.flatMap { String(data: $0, encoding: .utf8) }
                    $0.error = error
                }
                completed.fulfill()
            }.resume()

            wait(for: [completed], timeout: 5)
            session.finishTasksAndInvalidate()
        } catch {
            outcome.update { $0.error = error }
            completed.fulfill()
            wait(for: [completed], timeout: 1)
        }

        return outcome.value
    }

    private func assertWebSocketRejectsMismatchingPin(url: URL) {
        let rejected = expectation(description: "WebSocket pin mismatch rejected")
        rejected.assertForOverFulfill = false
        let receiveFailed = expectation(description: "WebSocket receive failed")
        let unexpectedlyOpened = expectation(description: "WebSocket must not open")
        unexpectedlyOpened.isInverted = true
        let policyViolation = LockedBox<Error?>(nil)
        let receiveError = LockedBox<Error?>(nil)

        do {
            let policy = try PinnedTrustPolicy(
                url: url,
                requiredScheme: "wss",
                fingerprint: Self.invalidFingerprint
            )
            let delegate = PinnedSessionDelegate(policy: policy)
            delegate.onPolicyViolation = { error in
                policyViolation.set(error)
                rejected.fulfill()
            }
            delegate.onWebSocketOpen = { _ in
                unexpectedlyOpened.fulfill()
            }
            let session = URLSession(
                configuration: .ephemeral,
                delegate: delegate,
                delegateQueue: nil
            )
            let task = session.webSocketTask(with: url, protocols: ["procman"])
            task.resume()
            task.receive { result in
                if case let .failure(error) = result {
                    receiveError.set(error)
                }
                receiveFailed.fulfill()
            }

            wait(for: [rejected, receiveFailed], timeout: 5)
            wait(for: [unexpectedlyOpened], timeout: 0.2)
            XCTAssertEqual(
                policyViolation.value as? PinnedTransportError,
                .fingerprintMismatch
            )
            XCTAssertNotNil(receiveError.value)
            task.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
        } catch {
            XCTFail("Unable to create mismatching WebSocket policy: \(error)")
        }
    }

    private func assertWebSocketAcceptsMatchingPin(url: URL, fingerprint: String) {
        let opened = expectation(description: "Pinned WebSocket opened")
        let received = expectation(description: "Pinned WebSocket received message")
        let selectedProtocol = LockedBox<String?>(nil)
        let message = LockedBox<String?>(nil)
        let receiveError = LockedBox<Error?>(nil)
        let policyViolation = LockedBox<Error?>(nil)

        do {
            let policy = try PinnedTrustPolicy(
                url: url,
                requiredScheme: "wss",
                fingerprint: fingerprint
            )
            let delegate = PinnedSessionDelegate(policy: policy)
            delegate.onPolicyViolation = { error in
                policyViolation.set(error)
            }
            delegate.onWebSocketOpen = { protocolName in
                selectedProtocol.set(protocolName)
                opened.fulfill()
            }
            let session = URLSession(
                configuration: .ephemeral,
                delegate: delegate,
                delegateQueue: nil
            )
            let task = session.webSocketTask(with: url, protocols: ["procman"])
            task.resume()
            task.receive { result in
                switch result {
                case let .success(receivedMessage):
                    if case let .string(value) = receivedMessage {
                        message.set(value)
                    }
                case let .failure(error):
                    receiveError.set(error)
                }
                received.fulfill()
            }

            wait(for: [opened, received], timeout: 5)
            XCTAssertEqual(selectedProtocol.value, "procman")
            XCTAssertEqual(message.value, "pinned-websocket-ok")
            XCTAssertNil(receiveError.value)
            XCTAssertNil(policyViolation.value)
            task.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
        } catch {
            XCTFail("Unable to create matching WebSocket policy: \(error)")
        }
    }

    private static let invalidFingerprint = String(repeating: "00", count: 32)
}

private struct RESTOutcome {
    var status: Int?
    var body: String?
    var error: Error?
    var policyViolation: Error?
}

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value

    init(_ value: Value) {
        storage = value
    }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func set(_ value: Value) {
        lock.lock()
        storage = value
        lock.unlock()
    }

    func update(_ body: (inout Value) -> Void) {
        lock.lock()
        body(&storage)
        lock.unlock()
    }
}

private final class LocalTLSServer: @unchecked Sendable {
    enum Mode {
        case http
        case webSocket
    }

    private let mode: Mode
    private let identity: LocalTLSIdentity
    private let queue = DispatchQueue(label: "kr.procman.pinned-transport-test-server")
    private let ready = DispatchSemaphore(value: 0)
    private let stateError = LockedBox<Error?>(nil)
    private let connectionLock = NSLock()
    private var connections: [NWConnection] = []
    private let listener: NWListener

    init(mode: Mode, identity: LocalTLSIdentity) throws {
        self.mode = mode
        self.identity = identity

        let tlsOptions = NWProtocolTLS.Options()
        guard let networkIdentity = sec_identity_create(identity.identity) else {
            throw LocalTLSError.unableToCreateNetworkIdentity
        }
        sec_protocol_options_set_local_identity(
            tlsOptions.securityProtocolOptions,
            networkIdentity
        )

        let parameters = NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options())
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)

        if mode == .webSocket {
            let webSocketOptions = NWProtocolWebSocket.Options()
            webSocketOptions.autoReplyPing = true
            webSocketOptions.setClientRequestHandler(queue) { subprotocols, _ in
                NWProtocolWebSocket.Response(
                    status: .accept,
                    subprotocol: subprotocols.first
                )
            }
            parameters.defaultProtocolStack.applicationProtocols.insert(
                webSocketOptions,
                at: 0
            )
        }

        listener = try NWListener(using: parameters, on: .any)
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.ready.signal()
            case let .failed(error):
                self.stateError.set(error)
                self.ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        guard ready.wait(timeout: .now() + 5) == .success else {
            listener.cancel()
            throw LocalTLSError.listenerTimedOut
        }
        if let error = stateError.value {
            listener.cancel()
            throw error
        }
        guard listener.port != nil else {
            listener.cancel()
            throw LocalTLSError.missingListenerPort
        }
    }

    func url(scheme: String, path: String) -> URL? {
        guard let port = listener.port else { return nil }
        return URL(string: "\(scheme)://127.0.0.1:\(port.rawValue)\(path)")
    }

    func stop() {
        listener.cancel()
        connectionLock.lock()
        let activeConnections = connections
        connections.removeAll()
        connectionLock.unlock()
        activeConnections.forEach { $0.cancel() }
    }

    private func accept(_ connection: NWConnection) {
        connectionLock.lock()
        connections.append(connection)
        connectionLock.unlock()

        switch mode {
        case .http:
            connection.start(queue: queue)
            receiveHTTPRequest(on: connection, accumulated: Data())
        case .webSocket:
            connection.stateUpdateHandler = { [weak self, weak connection] state in
                guard let self, let connection, case .ready = state else { return }
                self.sendWebSocketWelcome(on: connection)
            }
            connection.start(queue: queue)
        }
    }

    private func receiveHTTPRequest(on connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) {
            [weak self, weak connection] content, _, _, error in
            guard let self, let connection else { return }
            if error != nil {
                connection.cancel()
                return
            }

            var request = accumulated
            if let content {
                request.append(content)
            }
            guard request.count <= 65_536 else {
                connection.cancel()
                return
            }
            guard request.range(of: Data("\r\n\r\n".utf8)) != nil else {
                self.receiveHTTPRequest(on: connection, accumulated: request)
                return
            }

            let response = Data(
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".utf8
            )
            connection.send(content: response, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func sendWebSocketWelcome(on connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(
            identifier: "pinned-websocket-welcome",
            metadata: [metadata]
        )
        connection.send(
            content: Data("pinned-websocket-ok".utf8),
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { error in
                if error != nil {
                    connection.cancel()
                }
            }
        )
    }
}

private final class LocalTLSIdentity: @unchecked Sendable {
    let identity: SecIdentity
    let fingerprint: String

    private var temporaryKeychain: SecKeychain?
    private var temporaryKeychainURL: URL?

    init() throws {
        guard let pkcs12 = Data(base64Encoded: Self.pkcs12Base64) else {
            throw LocalTLSError.invalidFixture
        }

        var options: [String: Any] = [
            kSecImportExportPassphrase as String: Self.password,
        ]
        if #available(macOS 15, *) {
            options[kSecImportToMemoryOnly as String] = true
        } else {
            let keychainURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("procman-pinned-test-\(UUID().uuidString).keychain-db")
            var keychain: SecKeychain?
            let status = Self.password.withCString { passwordPointer in
                SecKeychainCreate(
                    keychainURL.path,
                    UInt32(Self.password.utf8.count),
                    passwordPointer,
                    false,
                    nil,
                    &keychain
                )
            }
            guard status == errSecSuccess, let keychain else {
                throw LocalTLSError.keychainCreationFailed(status)
            }
            temporaryKeychain = keychain
            temporaryKeychainURL = keychainURL
            options[kSecImportExportKeychain as String] = keychain
        }

        var importedItems: CFArray?
        let status = SecPKCS12Import(
            pkcs12 as CFData,
            options as CFDictionary,
            &importedItems
        )
        guard status == errSecSuccess,
              let items = importedItems as? [[String: Any]],
              let first = items.first,
              let identityValue = first[kSecImportItemIdentity as String]
        else {
            throw LocalTLSError.pkcs12ImportFailed(status)
        }
        guard CFGetTypeID(identityValue as CFTypeRef) == SecIdentityGetTypeID() else {
            throw LocalTLSError.pkcs12ImportFailed(errSecInvalidItemRef)
        }
        let importedIdentity = identityValue as! SecIdentity
        identity = importedIdentity

        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(importedIdentity, &certificate) == errSecSuccess,
              let certificate
        else {
            throw LocalTLSError.missingCertificate
        }
        let certificateData = SecCertificateCopyData(certificate) as Data
        fingerprint = SHA256.hash(data: certificateData)
            .map { String(format: "%02X", $0) }
            .joined(separator: ":")
    }

    deinit {
        if let temporaryKeychain {
            SecKeychainDelete(temporaryKeychain)
        }
        if let temporaryKeychainURL {
            try? FileManager.default.removeItem(at: temporaryKeychainURL)
        }
    }

    private static let password = "procman-test"
    // Public, test-only PKCS#12 fixture. It contains no production key
    // material and exists solely so CI can host a self-signed loopback TLS
    // endpoint without invoking openssl or reaching an external network.
    private static let pkcs12Base64 = [
        "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",
    ].joined()
}

private enum LocalTLSError: Error {
    case invalidFixture
    case unableToCreateNetworkIdentity
    case keychainCreationFailed(OSStatus)
    case pkcs12ImportFailed(OSStatus)
    case missingCertificate
    case listenerTimedOut
    case missingListenerPort
}
#endif
