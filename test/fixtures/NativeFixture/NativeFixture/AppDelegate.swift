import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UIScrollViewDelegate {
    var window: UIWindow?
    private let gestureStatus = UILabel()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBlue
        gestureStatus.frame = CGRect(x: 20, y: 60, width: 300, height: 40)
        gestureStatus.text = "idle"
        gestureStatus.accessibilityIdentifier = "gestureStatus"
        gestureStatus.accessibilityValue = "idle"
        controller.view.addSubview(gestureStatus)

        let pressTarget = UILabel(frame: CGRect(x: 20, y: 105, width: 300, height: 40))
        pressTarget.text = "Hold here"
        pressTarget.isUserInteractionEnabled = true
        pressTarget.accessibilityIdentifier = "pressTarget"
        pressTarget.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(didLongPress(_:))))
        controller.view.addSubview(pressTarget)

        let scroll = UIScrollView(frame: CGRect(x: 0, y: 155, width: window.bounds.width, height: window.bounds.height - 155))
        scroll.accessibilityIdentifier = "resultsList"
        scroll.contentSize = CGSize(width: window.bounds.width, height: 1500)
        scroll.delegate = self
        for index in 0..<25 {
            let label = UILabel(frame: CGRect(x: 20, y: CGFloat(index * 60), width: 300, height: 50))
            label.text = "Item \(index)"
            scroll.addSubview(label)
        }
        controller.view.addSubview(scroll)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window

        let runID = ProcessInfo.processInfo.environment["AGEMU_NATIVE_RUN_ID"] ?? "missing"
        NSLog("agemu-native-run:%@", runID)
        return true
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView.contentOffset.y > 100 { setGestureStatus("scrolled") }
    }

    @objc private func didLongPress(_ recognizer: UILongPressGestureRecognizer) {
        if recognizer.state == .began { setGestureStatus("pressed") }
    }

    private func setGestureStatus(_ value: String) {
        gestureStatus.text = value
        gestureStatus.accessibilityValue = value
    }
}
