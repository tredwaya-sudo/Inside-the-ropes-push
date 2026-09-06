import Foundation

/// Thin client for the Inside the Ropes background push server.
///
/// Configure `PushAPI.baseURL` once at launch (see PushRegistration / App init).
enum PushAPI {

    /// Production or staging push server. No trailing slash.
    /// Example: https://push.insidetheropes.app
    static var baseURL: URL = URL(string: "http://127.0.0.1:8787")!

    enum APIError: Error {
        case notConfigured
        case badStatus(Int)
        case encoding
    }

    struct FollowDTO: Codable, Hashable {
        let type: String   // "player" | "team"
        let id: String
        let name: String?

        init(type: String, id: String, name: String? = nil) {
            self.type = type
            self.id = id
            self.name = name
        }

        init(target: FollowTarget, name: String? = nil) {
            switch target {
            case .player(let id):
                self.type = "player"
                self.id = id
            case .team(let id):
                self.type = "team"
                self.id = id
            }
            self.name = name
        }
    }

    struct RegisterBody: Codable {
        let deviceToken: String
        let platform: String
        let follows: [FollowDTO]
        let eventIds: [String]
    }

    // MARK: - Public API

    static func registerDevice(
        token: String,
        follows: [FollowDTO],
        eventIds: [String]
    ) async throws {
        let body = RegisterBody(
            deviceToken: token,
            platform: "ios",
            follows: follows,
            eventIds: eventIds
        )
        _ = try await request(
            method: "POST",
            path: "/v1/devices",
            body: body
        )
    }

    static func syncFollows(token: String, follows: [FollowDTO]) async throws {
        struct Body: Codable { let follows: [FollowDTO] }
        _ = try await request(
            method: "PUT",
            path: "/v1/devices/\(token)/follows",
            body: Body(follows: follows)
        )
    }

    static func syncEvents(token: String, eventIds: [String]) async throws {
        struct Body: Codable { let eventIds: [String] }
        _ = try await request(
            method: "POST",
            path: "/v1/devices/\(token)/events",
            body: Body(eventIds: eventIds)
        )
    }

    static func unregister(token: String) async throws {
        var request = URLRequest(url: URL(string: "v1/devices/\(token)", relativeTo: baseURL)!.absoluteURL)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badStatus(-1) }
        guard http.statusCode == 204 || http.statusCode == 404 else {
            throw APIError.badStatus(http.statusCode)
        }
    }

    // MARK: - Internals

    private static func request<T: Encodable>(
        method: String,
        path: String,
        body: T
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            request.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw APIError.encoding
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badStatus(-1) }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.badStatus(http.statusCode)
        }
        return data
    }
}
