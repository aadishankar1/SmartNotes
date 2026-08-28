import Foundation

/// Transport is abstracted so the sync engine can be exercised without a
/// socket. The sandboxes this project is built in cannot bind or dial one, and
/// a sync rule that is only reachable through a live server is a rule that
/// never gets tested.
public struct HTTPRequest: Sendable {
    public var method: String
    /// Path with the `/v1` prefix and any query string already applied.
    public var path: String
    public var headers: [String: String]
    public var body: Data?

    public init(method: String, path: String, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

public protocol Transport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

/// Failures are split by what the app should *do* about them: an offline
/// failure keeps the outbox and retries, an unauthorized one sends the user
/// back to the token screen, and a server error is shown as-is.
public enum APIError: Error, CustomStringConvertible {
    case offline(String)
    case unauthorized(String)
    case server(status: Int, code: String, message: String)
    case malformed(String)

    public var isOffline: Bool {
        if case .offline = self { return true }
        return false
    }

    public var isUnauthorized: Bool {
        if case .unauthorized = self { return true }
        return false
    }

    public var description: String {
        switch self {
        case let .offline(detail): return "offline: \(detail)"
        case let .unauthorized(detail): return "unauthorized: \(detail)"
        case let .server(status, code, message): return "server \(status) \(code): \(message)"
        case let .malformed(detail): return "malformed response: \(detail)"
        }
    }

    /// What the UI shows. Kept separate from `description`, which is for logs.
    public var userMessage: String {
        switch self {
        case .offline:
            return "You're offline. Changes are saved on this iPad and will sync when the connection returns."
        case .unauthorized:
            return "This API token was rejected. Paste a current token to continue."
        case let .server(_, _, message):
            return message
        case .malformed:
            return "The server sent a response SmartNotes could not read."
        }
    }
}

/// `URLSession` transport. The offline classification is deliberately broad:
/// anything that means "the request never reached the server" is offline, so a
/// flaky network keeps queued work instead of surfacing as a hard failure.
public struct URLSessionTransport: Transport {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    private static let offlineCodes: Set<URLError.Code> = [
        .notConnectedToInternet,
        .networkConnectionLost,
        .cannotConnectToHost,
        .cannotFindHost,
        .dnsLookupFailed,
        .timedOut,
        .internationalRoamingOff,
        .dataNotAllowed,
        .callIsActive,
        .resourceUnavailable,
    ]

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let url = URL(string: request.path, relativeTo: baseURL) else {
            throw APIError.malformed("cannot build a URL for \(request.path)")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        for (key, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: key) }

        do {
            let (data, response) = try await session.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.malformed("response was not HTTP")
            }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key.lowercased()] = value }
            }
            return HTTPResponse(status: http.statusCode, headers: headers, body: data)
        } catch let error as URLError {
            if Self.offlineCodes.contains(error.code) { throw APIError.offline(error.localizedDescription) }
            throw APIError.malformed(error.localizedDescription)
        }
    }
}

/// The SmartNotes API.
///
/// Notebooks and PDFs are created over REST because the server owns fields the
/// client may not write (`ownerId`, `sha256`, `byteSize`). Everything else —
/// notes, annotations, ink — is authored as operations and travels through
/// `POST /v1/sync`, which is the same single write path the server uses for its
/// own REST edits.
public final class APIClient: @unchecked Sendable {
    private let transport: Transport
    private let lock = NSLock()
    private var storedToken: String?

    public init(transport: Transport, token: String? = nil) {
        self.transport = transport
        self.storedToken = token
    }

    public var token: String? {
        get { lock.withLock { storedToken } }
        set { lock.withLock { storedToken = newValue } }
    }

    // MARK: - Auth

    /// The MVP authenticates with a server-issued API token rather than a
    /// signup flow, so the only auth call the app makes is this identity probe.
    public func me() async throws -> User {
        try await request(UserEnvelope.self, "GET", "\(API.prefix)/me").user
    }

    public func login(email: String, password: String) async throws -> AuthResponse {
        try await request(AuthResponse.self, "POST", "\(API.prefix)/auth/login", body: ["email": email, "password": password])
    }

    // MARK: - Notebooks

    public func notebooks() async throws -> [Notebook] {
        try await request(NotebooksEnvelope.self, "GET", "\(API.prefix)/notebooks").notebooks
    }

    public func createNotebook(title: String, color: String?) async throws -> Notebook {
        try await request(
            NotebookEnvelope.self,
            "POST",
            "\(API.prefix)/notebooks",
            body: NotebookCreateRequest(title: title, color: color)
        ).notebook
    }

    public func notebook(_ id: String) async throws -> NotebookDetail {
        try await request(NotebookDetail.self, "GET", "\(API.prefix)/notebooks/\(escape(id))")
    }

    // MARK: - PDFs

    public func pdfs(notebookId: String) async throws -> [PdfDocument] {
        try await request(PdfsEnvelope.self, "GET", "\(API.prefix)/notebooks/\(escape(notebookId))/pdfs").pdfs
    }

    public func uploadPdf(notebookId: String, filename: String, bytes: Data, pageCount: Int?) async throws -> PdfDocument {
        try await request(
            PdfEnvelope.self,
            "POST",
            "\(API.prefix)/pdfs",
            body: PdfUploadRequest(
                notebookId: notebookId,
                filename: filename,
                content: bytes.base64EncodedString(),
                pageCount: pageCount
            )
        ).pdf
    }

    /// Returns raw PDF bytes rather than JSON, so it bypasses the decoder.
    public func pdfContent(_ pdfId: String) async throws -> Data {
        let response = try await send(HTTPRequest(method: "GET", path: "\(API.prefix)/pdfs/\(escape(pdfId))/content", headers: authHeaders()))
        try throwIfFailed(response)
        return response.body
    }

    public func annotations(pdfId: String) async throws -> AnnotationsResponse {
        try await request(AnnotationsResponse.self, "GET", "\(API.prefix)/pdfs/\(escape(pdfId))/annotations")
    }

    // MARK: - Sync

    public func sync(_ request: SyncRequest) async throws -> SyncResponse {
        try await self.request(SyncResponse.self, "POST", "\(API.prefix)/sync", body: request)
    }

    // MARK: - Plumbing

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }

    private func authHeaders() -> [String: String] {
        guard let token = token else { return [:] }
        return ["authorization": "Bearer \(token)"]
    }

    private func request<T: Decodable>(_ type: T.Type, _ method: String, _ path: String) async throws -> T {
        try decode(type, from: try await perform(method, path, body: nil))
    }

    private func request<T: Decodable, B: Encodable>(_ type: T.Type, _ method: String, _ path: String, body: B) async throws -> T {
        let encoded = try JSONEncoder().encode(body)
        return try decode(type, from: try await perform(method, path, body: encoded))
    }

    private func perform(_ method: String, _ path: String, body: Data?) async throws -> HTTPResponse {
        var headers = authHeaders()
        headers["accept"] = "application/json"
        if body != nil { headers["content-type"] = "application/json" }
        let response = try await send(HTTPRequest(method: method, path: path, headers: headers, body: body))
        try throwIfFailed(response)
        return response
    }

    private func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        do {
            return try await transport.send(request)
        } catch let error as APIError {
            throw error
        } catch let error as URLError {
            throw APIError.offline(error.localizedDescription)
        }
    }

    private func throwIfFailed(_ response: HTTPResponse) throws {
        guard response.status >= 400 else { return }
        let body = try? JSONDecoder().decode(ErrorBody.self, from: response.body)
        let code = body?.error.code ?? "http_\(response.status)"
        let message = body?.error.message ?? "request failed with status \(response.status)"
        if response.status == 401 || response.status == 403 { throw APIError.unauthorized(message) }
        throw APIError.server(status: response.status, code: code, message: message)
    }

    private func decode<T: Decodable>(_ type: T.Type, from response: HTTPResponse) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: response.body)
        } catch {
            throw APIError.malformed("\(type): \(error)")
        }
    }
}

extension NSLock {
    fileprivate func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
