import Foundation
import UIKit
import UserNotifications

/// Registers for remote notifications, captures the APNs device token, and
/// keeps the push server in sync with local follows / watched events.
///
/// Wire this up from `InsideTheRopesApp` via `@UIApplicationDelegateAdaptor`.
final class PushRegistration: NSObject, ObservableObject {
    static let shared = PushRegistration()

    @Published private(set) var deviceTokenHex: String?
    @Published private(set) var lastError: String?

    private let tokenKey = "itr.push.deviceToken"

    override init() {
        super.init()
        deviceTokenHex = UserDefaults.standard.string(forKey: tokenKey)
    }

    /// Call after notification permission is granted (or when the app becomes active).
    func registerForRemoteNotifications() {
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func handleDeviceToken(_ tokenData: Data) {
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        deviceTokenHex = hex
        UserDefaults.standard.set(hex, forKey: tokenKey)
        lastError = nil
    }

    func handleRegistrationError(_ error: Error) {
        lastError = error.localizedDescription
        #if DEBUG
        print("[PushRegistration] \(error)")
        #endif
    }

    /// Full register: token + current follows + event ids the app cares about.
    func syncToServer(follows: [FollowRecord], eventIds: [String]) async {
        guard let token = deviceTokenHex else { return }
        let dtos = follows.map { PushAPI.FollowDTO(target: $0.target, name: $0.name) }
        do {
            try await PushAPI.registerDevice(
                token: token,
                follows: dtos,
                eventIds: Array(Set(eventIds))
            )
        } catch {
            lastError = error.localizedDescription
            #if DEBUG
            print("[PushRegistration] sync: \(error)")
            #endif
        }
    }

    func syncFollowsOnly(_ follows: [FollowRecord]) async {
        guard let token = deviceTokenHex else { return }
        let dtos = follows.map { PushAPI.FollowDTO(target: $0.target, name: $0.name) }
        do {
            try await PushAPI.syncFollows(token: token, follows: dtos)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func syncEventsOnly(_ eventIds: [String]) async {
        guard let token = deviceTokenHex else { return }
        do {
            try await PushAPI.syncEvents(token: token, eventIds: Array(Set(eventIds)))
        } catch {
            lastError = error.localizedDescription
        }
    }
}

// MARK: - UIApplicationDelegate bridge

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushRegistration.shared.handleDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushRegistration.shared.handleRegistrationError(error)
    }
}
