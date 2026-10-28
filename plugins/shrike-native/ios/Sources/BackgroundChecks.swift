import Foundation
import BackgroundTasks
import Capacitor
import UserNotifications

/// Notifications from the phone itself, and the background checks that find something to say.
///
/// iOS wakes the app for a check when it chooses: no sooner than 15 minutes after the last one was asked for, often
/// later, and never after the person swipes the app away. The page does the checking (src/app/model.ts,
/// backgroundCheck) and calls backgroundCheckDone; until then the task stays open, for at most the 30 or so
/// seconds iOS allows.
extension ShrikeNativePlugin {
    /// Also listed in Info.plist under BGTaskSchedulerPermittedIdentifiers
    public static let backgroundCheckId = "app.crossbill.background-check"
    private static let checksOnKey = "crossbill.backgroundChecks"
    private static let minimumInterval: TimeInterval = 15 * 60

    /// Tasks waiting for the page, by id. Touched on the main thread only
    private static var openTasks: [String: BGAppRefreshTask] = [:]
    /// The plugin, once the page's bridge has loaded it
    static weak var live: ShrikeNativePlugin?
    /// Checks that arrived before the plugin loaded
    private static var early: [(id: String, deadline: Double)] = []
    /// The page is told to finish this long after iOS woke the app, inside the 30 or so seconds iOS gives
    private static let budget: TimeInterval = 25

    /// Call from the app delegate's didFinishLaunching: iOS needs the handler before launch ends.
    public static func registerBackgroundCheck() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: backgroundCheckId, using: .main) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            startCheck(task)
        }
    }

    private static func startCheck(_ task: BGAppRefreshTask) {
        // The next one is asked for first, so checks go on even if this one runs out of time
        submitNext()
        let id = UUID().uuidString
        // Unix milliseconds, for the page's clock
        let deadline = (Date().timeIntervalSince1970 + budget) * 1000
        openTasks[id] = task
        task.expirationHandler = {
            DispatchQueue.main.async { finishCheck(id, ok: false) }
        }
        if let plugin = live {
            plugin.sendCheck(id, deadline: deadline)
        } else {
            early.append((id: id, deadline: deadline))
        }
    }

    /// Kept until the page listens: on a launch in the background, the page loads after the task arrives
    fileprivate func sendCheck(_ id: String, deadline: Double) {
        notifyListeners("backgroundCheck", data: ["id": id, "deadline": deadline], retainUntilConsumed: true)
    }

    /// From load(): hands over any check that arrived before the plugin existed.
    func backgroundChecksLoaded() {
        DispatchQueue.main.async {
            ShrikeNativePlugin.live = self
            let waiting = ShrikeNativePlugin.early
            ShrikeNativePlugin.early = []
            for check in waiting { self.sendCheck(check.id, deadline: check.deadline) }
        }
    }

    private static func finishCheck(_ id: String, ok: Bool) {
        guard let task = openTasks.removeValue(forKey: id) else { return }
        task.setTaskCompleted(success: ok)
    }

    private static func submitNext() {
        guard UserDefaults.standard.bool(forKey: checksOnKey) else { return }
        let request = BGAppRefreshTaskRequest(identifier: backgroundCheckId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: minimumInterval)
        // Fails in the simulator and when Background App Refresh is off for the app; iOS then simply never asks
        try? BGTaskScheduler.shared.submit(request)
    }

    @objc func backgroundChecks(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        UserDefaults.standard.set(on, forKey: ShrikeNativePlugin.checksOnKey)
        DispatchQueue.main.async {
            if on {
                ShrikeNativePlugin.submitNext()
            } else {
                BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: ShrikeNativePlugin.backgroundCheckId)
            }
            call.resolve()
        }
    }

    @objc func backgroundCheckDone(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let ok = call.getBool("ok") ?? false
        DispatchQueue.main.async {
            ShrikeNativePlugin.finishCheck(id, ok: ok)
            call.resolve()
        }
    }

    // MARK: Notifications

    @objc func notifyPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            call.resolve(["granted": granted])
        }
    }

    @objc func notifyStatus(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: String
            switch settings.authorizationStatus {
            case .notDetermined: status = "notDetermined"
            case .denied: status = "denied"
            default: status = "granted"
            }
            call.resolve(["status": status])
        }
    }

    @objc func notify(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let title = call.getString("title"), let body = call.getString("body") else {
            call.reject("Missing id, title or body")
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        // No trigger: shown now
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                call.reject(error.localizedDescription)
            } else {
                call.resolve()
            }
        }
    }
}
