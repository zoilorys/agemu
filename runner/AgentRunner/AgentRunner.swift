import XCTest

/// Element target fields shared by every targeted action (see src/commands/ui-elements.ts `ElementTarget`).
private protocol Targeting {
    var identifier: String? { get }
    var label: String? { get }
    var labelContains: String? { get }
    var type: String? { get }
    var index: Int? { get }
}

extension Targeting {
    var hasTarget: Bool { identifier != nil || label != nil || labelContains != nil }
    var targetDescription: String {
        let name = identifier ?? label ?? labelContains ?? "<no target>"
        let details = [type.map { "type \($0)" }, index.map { "index \($0)" }].compactMap { $0 }
        return details.isEmpty ? name : "\(name) (\(details.joined(separator: ", ")))"
    }
}

final class AgentRunner: XCTestCase {
    private struct Plan: Decodable { let bundleId: String; let actions: [Action] }
    private struct Action: Decodable {
        let launch: Launch?
        let tap: Target?
        let swipe: Swipe?
        let longPress: LongPress?
        let type: TypeAction?
        let wait: WaitAction?
        let assertVisible: Target?
        let assertExists: Target?
        let assertNotVisible: Target?
        let assertValue: ValueAssertion?
        let screenshot: Screenshot?
        let inspect: Empty?
        let startVideoRecording: VideoRecording?
        let stopVideoRecording: Empty?
        let clear: Target?
        let pressKey: KeyAction?
        let pressButton: ButtonAction?
        let openUrl: OpenUrl?
        let terminate: Empty?
        let scrollUntilVisible: ScrollUntilVisible?
        let assertText: TextAssertion?
    }
    private struct TargetFields: Decodable, Targeting {
        let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?
    }
    private struct ScrollUntilVisible: Decodable {
        let target: TargetFields; let `in`: TargetFields?; let direction: String?; let maxSwipes: Int?
    }
    private struct TextAssertion: Decodable, Targeting {
        let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?
        let equals: String?; let contains: String?; let matches: String?
    }
    private struct OpenUrl: Decodable { let url: String; let confirm: Bool? }
    private struct KeyAction: Decodable { let key: String; let count: Int? }
    private struct ButtonAction: Decodable { let button: String }
    private struct Launch: Decodable { let arguments: [String]?; let environment: [String: String]? }
    private struct Target: Decodable, Targeting {
        let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?; let x: Double?; let y: Double?
    }
    private struct Point: Decodable { let x: Double; let y: Double }
    private struct Swipe: Decodable, Targeting {
        let direction: String?; let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?
        let from: Point?; let to: Point?; let duration: Double?
    }
    private struct LongPress: Decodable, Targeting {
        let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?; let x: Double?; let y: Double?; let duration: Double?
    }
    private struct TypeAction: Decodable, Targeting {
        let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?; let text: String
    }
    private struct WaitAction: Decodable, Targeting {
        let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?; let timeout: Double?; let duration: Double?
    }
    private struct ValueAssertion: Decodable, Targeting {
        let identifier: String?; let label: String?; let labelContains: String?; let type: String?; let index: Int?; let value: String
    }
    private struct Screenshot: Decodable { let name: String? }
    private struct Empty: Decodable {}
    private struct VideoRecording: Decodable { let name: String? }
    private struct Node: Encodable {
        let type: String; let identifier: String; let label: String; let value: String
        let x, y, width, height: Double
        let enabled: Bool; let selected: Bool; let depth: Int
    }
    private struct Inspection: Encodable { let index: Int; let nodes: [Node] }
    private struct Result: Encodable { let completed: Int; let bundleId: String; let inspections: [Inspection] }
    private struct Failure: Encodable { let index: Int; let kind: String; let message: String }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func actionKind(_ action: Action) -> String {
        if action.launch != nil { return "launch" }
        if action.tap != nil { return "tap" }
        if action.swipe != nil { return "swipe" }
        if action.longPress != nil { return "longPress" }
        if action.type != nil { return "type" }
        if action.wait != nil { return "wait" }
        if action.assertVisible != nil { return "assertVisible" }
        if action.assertExists != nil { return "assertExists" }
        if action.assertNotVisible != nil { return "assertNotVisible" }
        if action.assertValue != nil { return "assertValue" }
        if action.screenshot != nil { return "screenshot" }
        if action.inspect != nil { return "inspect" }
        if action.startVideoRecording != nil { return "startVideoRecording" }
        if action.stopVideoRecording != nil { return "stopVideoRecording" }
        if action.clear != nil { return "clear" }
        if action.pressKey != nil { return "pressKey" }
        if action.pressButton != nil { return "pressButton" }
        if action.openUrl != nil { return "openUrl" }
        if action.terminate != nil { return "terminate" }
        if action.scrollUntilVisible != nil { return "scrollUntilVisible" }
        if action.assertText != nil { return "assertText" }
        return "unknown"
    }

    /// Matches the idb backend: UTF-16 units outside [A-Za-z0-9_-] become "_", capped at 80, default "screen".
    private func sanitizedScreenshotName(_ name: String?) -> String {
        guard let name else { return "screen" }
        let underscore = UInt16(UInt8(ascii: "_"))
        let units = name.utf16.prefix(80).map { unit -> UInt16 in
            switch unit {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x5F: return unit
            default: return underscore
            }
        }
        let sanitized = String(decoding: units, as: UTF16.self)
        return sanitized.isEmpty ? "screen" : sanitized
    }

    private var failureScreenshotCaptured = false

    /// Every failure, including XCUITest-internal ones that bypass reportFailure, gets one `agemu-failure` screenshot.
    override func record(_ issue: XCTIssue) {
        if !failureScreenshotCaptured && Thread.isMainThread {
            failureScreenshotCaptured = true
            MainActor.assumeIsolated {
                let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                attachment.name = "agemu-failure"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
        super.record(issue)
    }

    /// XCTFail routes through record(_:), which attaches the failure screenshot.
    private func reportFailure(index: Int, kind: String, message: String) {
        if let data = try? JSONEncoder().encode(Failure(index: index, kind: kind, message: message)) {
            print("AGEMU_FAILURE:\(data.base64EncodedString())")
            fflush(stdout)
        }
        XCTFail("Action \(index) (\(kind)): \(message)")
    }

    @MainActor
    func testPlan() throws {
        let encoded = try XCTUnwrap(ProcessInfo.processInfo.environment["AGEMU_PLAN_BASE64"])
        let data = try XCTUnwrap(Data(base64Encoded: encoded))
        let plan = try JSONDecoder().decode(Plan.self, from: data)
        let app = XCUIApplication(bundleIdentifier: plan.bundleId)
        var inspections: [Inspection] = []
        var completed = 0

        for (index, action) in plan.actions.enumerated() {
            let kind = actionKind(action)
            print("AGEMU_ACTION:\(index)")
            fflush(stdout)
            do {
                if let message = try perform(action, index: index, in: app, inspections: &inspections) {
                    reportFailure(index: index, kind: kind, message: message)
                    return
                }
            } catch {
                reportFailure(index: index, kind: kind, message: error.localizedDescription)
                return
            }
            completed += 1
        }

        let output = try JSONEncoder().encode(Result(completed: completed, bundleId: plan.bundleId, inspections: inspections))
        print("AGEMU_RESULT:\(output.base64EncodedString())")
        fflush(stdout)
    }

    /// Executes one action. Returns a failure message for a failed check, nil on success.
    @MainActor
    private func perform(_ action: Action, index: Int, in app: XCUIApplication, inspections: inout [Inspection]) throws -> String? {
            if let launch = action.launch {
                app.launchArguments = launch.arguments ?? []
                app.launchEnvironment = launch.environment ?? [:]
                app.launch()
            } else if let target = action.tap {
                try tap(target, in: app)
            } else if let swipe = action.swipe {
                try swipeGesture(swipe, in: app)
            } else if let press = action.longPress {
                try longPressGesture(press, in: app)
            } else if let type = action.type {
                let element = try element(type, in: app)
                element.tap()
                element.typeText(type.text)
            } else if let wait = action.wait {
                if let duration = wait.duration {
                    Thread.sleep(forTimeInterval: duration)
                } else {
                    let candidate = try element(wait, in: app)
                    if !candidate.waitForExistence(timeout: wait.timeout ?? 5) {
                        return "element did not appear: \(wait.targetDescription)"
                    }
                }
            } else if let target = action.assertVisible {
                let candidate = try element(target, in: app)
                let exists = candidate.exists
                if !(exists && candidate.isHittable) {
                    return "element is not visible: \(target.targetDescription)\(exists ? " (exists but not hittable)" : "")"
                }
            } else if let target = action.assertExists {
                if !(try element(target, in: app).exists) {
                    return "element does not exist: \(target.targetDescription)"
                }
            } else if let target = action.assertNotVisible {
                let candidate = try element(target, in: app)
                if candidate.exists && candidate.isHittable {
                    return "element is visible: \(target.targetDescription)"
                }
            } else if let assertion = action.assertValue {
                let candidate = try element(assertion, in: app)
                let actual = candidate.value as? String
                if actual != assertion.value {
                    return "element value does not match: expected \(assertion.value), got \(actual ?? "nil")"
                }
            } else if let shot = action.screenshot {
                let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                attachment.name = "agemu-\(index)-\(sanitizedScreenshotName(shot.name))"
                attachment.lifetime = .keepAlways
                add(attachment)
            } else if action.inspect != nil {
                var nodes: [Node] = []
                flatten(try app.snapshot(), depth: 0, into: &nodes)
                inspections.append(Inspection(index: index, nodes: nodes))
            } else if let video = action.startVideoRecording {
                try recordingRequest("/start?name=\((video.name ?? "video").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "video")")
            } else if action.stopVideoRecording != nil {
                try recordingRequest("/stop")
            } else if let target = action.clear {
                let candidate = try element(target, in: app)
                candidate.tap()
                let old = candidate.value as? String ?? ""
                // An empty field reports its placeholder as its value, so text equal to the placeholder is
                // indistinguishable here; deleting in an empty field is a no-op, so always delete old.count.
                if !old.isEmpty {
                    candidate.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
                    let new = candidate.value as? String ?? ""
                    if !new.isEmpty && new != (candidate.placeholderValue ?? "") { return "could not clear \(target.targetDescription)" }
                }
            } else if let press = action.pressKey {
                guard let key = keyboardKey(press.key) else { return "unsupported key \(press.key)" }
                app.typeText(String(repeating: key.rawValue, count: press.count ?? 1))
            } else if let press = action.pressButton {
                guard press.button == "home" else { return "unsupported button \(press.button)" }
                // Backgrounds the app; a later action on it needs `launch` first.
                XCUIDevice.shared.press(.home)
            } else if let open = action.openUrl {
                guard let url = URL(string: open.url) else { return "invalid url \(open.url)" }
                // system.open does not wait for the app's accessibility, which a pending SpringBoard prompt would block.
                if #available(iOS 16.4, *) { XCUIDevice.shared.system.open(url) } else { return "openUrl requires iOS 16.4 or newer" }
                if open.confirm != false {
                    // iOS shows SpringBoard's "Open in …?" prompt the first time a scheme is opened; the app's own UI is never touched.
                    let prompt = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
                    if prompt.waitForExistence(timeout: 2) { prompt.tap() }
                }
                // Best effort: the URL may target another app; later plan steps assert the outcome.
                _ = app.wait(for: .runningForeground, timeout: 5)
            } else if action.terminate != nil {
                app.terminate()
            } else if let scroll = action.scrollUntilVisible {
                return try scrollUntilVisible(scroll, in: app)
            } else if let assertion = action.assertText {
                return try assertText(assertion, in: app)
            } else {
                return "action has no supported operation"
            }
            return nil
    }

    /// Normalized type names shared with the idb backend (src/commands/ui-elements.ts).
    private func typeName(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .application: return "application"
        case .window: return "window"
        case .button: return "button"
        case .staticText: return "staticText"
        case .textField: return "textField"
        case .secureTextField: return "secureTextField"
        case .searchField: return "searchField"
        case .textView: return "textView"
        case .image: return "image"
        case .cell: return "cell"
        case .switch: return "switch"
        case .slider: return "slider"
        case .link: return "link"
        case .scrollView: return "scrollView"
        case .table: return "table"
        case .collectionView: return "collectionView"
        case .navigationBar: return "navigationBar"
        case .tabBar: return "tabBar"
        case .alert: return "alert"
        case .keyboard: return "keyboard"
        default: return "other"
        }
    }

    /// Pre-order (document order) flattening of a snapshot tree.
    @MainActor
    private func flatten(_ snapshot: XCUIElementSnapshot, depth: Int, into nodes: inout [Node]) {
        let frame = snapshot.frame
        // JSONEncoder rejects non-finite values (e.g. CGRect.null); a zero frame is reported as not visible.
        let finite = { (value: CGFloat) -> Double in value.isFinite ? Double(value) : 0 }
        nodes.append(Node(
            type: typeName(snapshot.elementType), identifier: snapshot.identifier, label: snapshot.label,
            value: snapshot.value.map { String(describing: $0) } ?? "",
            x: finite(frame.origin.x), y: finite(frame.origin.y), width: finite(frame.size.width), height: finite(frame.size.height),
            enabled: snapshot.isEnabled, selected: snapshot.isSelected, depth: depth))
        for child in snapshot.children { flatten(child, depth: depth + 1, into: &nodes) }
    }

    private func recordingRequest(_ path: String) throws {
        guard let port = ProcessInfo.processInfo.environment["AGEMU_VIDEO_PORT"],
              let url = URL(string: "http://127.0.0.1:\(port)\(path)") else {
            throw NSError(domain: "AgentRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "Recording bridge is unavailable"])
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        let semaphore = DispatchSemaphore(value: 0)
        var responseError: Error?
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { responseError = error }
            else if (response as? HTTPURLResponse)?.statusCode != 200 {
                responseError = NSError(domain: "AgentRunner", code: 4, userInfo: [NSLocalizedDescriptionKey: String(data: data ?? Data(), encoding: .utf8) ?? "Recording request failed"])
            }
            semaphore.signal()
        }.resume()
        if semaphore.wait(timeout: .now() + 30) == .timedOut {
            throw NSError(domain: "AgentRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Recording request timed out"])
        }
        if let responseError { throw responseError }
    }

    @MainActor
    /// Filters by every given field, then picks the `index`th match (default 0) in the query's order. Mirrors idb-ui.ts.
    private func element(_ target: any Targeting, in app: XCUIApplication) throws -> XCUIElement {
        var predicates: [NSPredicate] = []
        if let identifier = target.identifier { predicates.append(NSPredicate(format: "identifier == %@", identifier)) }
        if let label = target.label { predicates.append(NSPredicate(format: "label == %@", label)) }
        if let fragment = target.labelContains { predicates.append(NSPredicate(format: "label CONTAINS %@", fragment)) }
        guard !predicates.isEmpty else {
            throw NSError(domain: "AgentRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "Element target requires identifier, label, or labelContains"])
        }
        let query = app.descendants(matching: target.type.flatMap { elementType(for: $0) } ?? .any)
        return query.matching(NSCompoundPredicate(andPredicateWithSubpredicates: predicates)).element(boundBy: target.index ?? 0)
    }

    /// Plan key names (src/commands/ui.ts `pressKeys`) to keyboard keys.
    private func keyboardKey(_ name: String) -> XCUIKeyboardKey? {
        switch name {
        case "return": return .return
        case "delete": return .delete
        case "tab": return .tab
        case "space": return .space
        default: return nil
        }
    }

    /// Inverse of typeName(_:); nil for "other" and unknown names.
    private func elementType(for name: String) -> XCUIElement.ElementType? {
        switch name {
        case "application": return .application
        case "window": return .window
        case "button": return .button
        case "staticText": return .staticText
        case "textField": return .textField
        case "secureTextField": return .secureTextField
        case "searchField": return .searchField
        case "textView": return .textView
        case "image": return .image
        case "cell": return .cell
        case "switch": return .switch
        case "slider": return .slider
        case "link": return .link
        case "scrollView": return .scrollView
        case "table": return .table
        case "collectionView": return .collectionView
        case "navigationBar": return .navigationBar
        case "tabBar": return .tabBar
        case "alert": return .alert
        case "keyboard": return .keyboard
        default: return nil
        }
    }

    @MainActor
    private func tap(_ target: Target, in app: XCUIApplication) throws {
        if let x = target.x, let y = target.y {
            coordinate(x: x, y: y, in: app).tap()
        } else {
            try element(target, in: app).tap()
        }
    }

    @MainActor
    private func coordinate(x: Double, y: Double, in app: XCUIApplication) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    @MainActor
    private func longPressGesture(_ press: LongPress, in app: XCUIApplication) throws {
        let duration = press.duration ?? 1
        if let x = press.x, let y = press.y {
            coordinate(x: x, y: y, in: app).press(forDuration: duration)
        } else {
            try element(press, in: app).press(forDuration: duration)
        }
    }

    /// Swipes `in` (or the app) until the target is visible (`exists && isHittable`), at most `maxSwipes` times. Mirrors idb-ui.ts.
    @MainActor
    private func scrollUntilVisible(_ scroll: ScrollUntilVisible, in app: XCUIApplication) throws -> String? {
        let target = try element(scroll.target, in: app)
        let maxSwipes = scroll.maxSwipes ?? 10
        var swipes = 0
        while !(target.exists && target.isHittable) {
            if swipes >= maxSwipes { return "target not visible after \(swipes) swipes: \(scroll.target.targetDescription)" }
            var surface: XCUIElement = app
            if let container = scroll.`in` {
                surface = try element(container, in: app)
                if !surface.exists { return "container not found: \(container.targetDescription)" }
            }
            switch scroll.direction ?? "up" {
            case "up": surface.swipeUp()
            case "down": surface.swipeDown()
            case "left": surface.swipeLeft()
            case "right": surface.swipeRight()
            default: return "unsupported direction \(scroll.direction ?? "")"
            }
            swipes += 1
            Thread.sleep(forTimeInterval: 0.3)
        }
        return nil
    }

    /// Compares the element's value (or its label when the value is empty) by one mode. Mirrors idb-ui.ts `textMismatch`.
    @MainActor
    private func assertText(_ assertion: TextAssertion, in app: XCUIApplication) throws -> String? {
        let candidate = try element(assertion, in: app)
        if !candidate.exists { return "element not found: \(assertion.targetDescription)" }
        let value = candidate.value as? String ?? ""
        let text = value.isEmpty ? candidate.label : value
        let result: (mode: String, expected: String, passed: Bool)
        if let equals = assertion.equals {
            result = ("equals", equals, text == equals)
        } else if let contains = assertion.contains {
            result = ("contains", contains, text.contains(contains))
        } else if let pattern = assertion.matches {
            // ICU and JavaScript regex dialects differ; an ICU-only rejection is an action failure, not a crash.
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return "invalid regular expression: \(pattern)" }
            result = ("matches", pattern, regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil)
        } else {
            return "assertText needs equals, contains, or matches"
        }
        return result.passed ? nil : "text does not match: expected \(result.mode) \(result.expected), got \(text)"
    }

    @MainActor
    private func swipeGesture(_ swipe: Swipe, in app: XCUIApplication) throws {
        if let from = swipe.from, let to = swipe.to {
            let start = coordinate(x: from.x, y: from.y, in: app)
            let end = coordinate(x: to.x, y: to.y, in: app)
            if let duration = swipe.duration {
                let distance = hypot(to.x - from.x, to.y - from.y)
                start.press(forDuration: 0.05, thenDragTo: end,
                    withVelocity: XCUIGestureVelocity(CGFloat(distance / duration)), thenHoldForDuration: 0)
            } else {
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            return
        }
        let surface = swipe.hasTarget ? try element(swipe, in: app) : app
        let distance = (swipe.direction == "up" || swipe.direction == "down") ? surface.frame.height : surface.frame.width
        let velocity = swipe.duration.map { XCUIGestureVelocity(CGFloat(distance * 0.3 / $0)) }
        switch swipe.direction {
        case "up": if let velocity { surface.swipeUp(velocity: velocity) } else { surface.swipeUp() }
        case "down": if let velocity { surface.swipeDown(velocity: velocity) } else { surface.swipeDown() }
        case "left": if let velocity { surface.swipeLeft(velocity: velocity) } else { surface.swipeLeft() }
        case "right": if let velocity { surface.swipeRight(velocity: velocity) } else { surface.swipeRight() }
        default: throw NSError(domain: "AgentRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "Swipe requires a direction or coordinates"])
        }
    }
}
