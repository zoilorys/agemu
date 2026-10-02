import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UIScrollViewDelegate {
    var window: UIWindow?
    private let gestureStatus = UILabel()
    private let nameField = UITextField() // ui-inspection

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

        // BEGIN ui-inspection controls
        nameField.frame = CGRect(x: 20, y: 155, width: 200, height: 36)
        nameField.placeholder = "Name"
        nameField.borderStyle = .roundedRect
        nameField.accessibilityIdentifier = "nameField"
        controller.view.addSubview(nameField)

        let saveButton = UIButton(type: .system)
        saveButton.frame = CGRect(x: 230, y: 155, width: 70, height: 36)
        saveButton.setTitle("Save", for: .normal)
        saveButton.accessibilityIdentifier = "saveButton"
        saveButton.addTarget(self, action: #selector(didTapSave), for: .touchUpInside)
        controller.view.addSubview(saveButton)

        let saveDraftButton = UIButton(type: .system)
        saveDraftButton.frame = CGRect(x: 20, y: 196, width: 120, height: 36)
        saveDraftButton.setTitle("Save draft", for: .normal)
        saveDraftButton.accessibilityIdentifier = "saveDraftButton"
        saveDraftButton.addTarget(self, action: #selector(didTapSaveDraft), for: .touchUpInside)
        controller.view.addSubview(saveDraftButton)
        // END ui-inspection controls

        let scroll = UIScrollView(frame: CGRect(x: 0, y: 240, width: window.bounds.width, height: window.bounds.height - 240))
        scroll.accessibilityIdentifier = "resultsList"
        scroll.contentSize = CGSize(width: window.bounds.width, height: 1500)
        scroll.delegate = self
        for index in 0..<25 {
            let label = UILabel(frame: CGRect(x: 20, y: CGFloat(index * 60), width: 300, height: 50))
            label.text = "Item \(index)"
            label.accessibilityIdentifier = "row"
            scroll.addSubview(label)
        }
        controller.view.addSubview(scroll)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window

        let runID = ProcessInfo.processInfo.environment["AGEMU_NATIVE_RUN_ID"] ?? "missing"
        NSLog("agemu-native-run:%@", runID)

        if ProcessInfo.processInfo.environment["AGEMU_FIXTURE_CRASH"] == "1" {
            fatalError("agemu fixture crash")
        }
        return true
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView.contentOffset.y > 100 { setGestureStatus("scrolled") }
    }

    @objc private func didLongPress(_ recognizer: UILongPressGestureRecognizer) {
        if recognizer.state == .began { setGestureStatus("pressed") }
    }

    // BEGIN ui-inspection handlers
    @objc private func didTapSave() {
        setGestureStatus("saved:\(nameField.text ?? "")")
    }

    @objc private func didTapSaveDraft() {
        setGestureStatus("draft")
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        setGestureStatus("opened:\(url.host ?? "")\(url.path)")
        return true
    }
    // END ui-inspection handlers

    private func setGestureStatus(_ value: String) {
        gestureStatus.text = value
        gestureStatus.accessibilityValue = value
    }
}
