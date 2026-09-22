import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBlue
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window

        let runID = ProcessInfo.processInfo.environment["AGEMU_NATIVE_RUN_ID"] ?? "missing"
        NSLog("agemu-native-run:%@", runID)
        return true
    }
}
