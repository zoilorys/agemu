import XCTest

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
    }
    private struct Launch: Decodable { let arguments: [String]?; let environment: [String: String]? }
    private struct Target: Decodable { let identifier: String?; let label: String?; let x: Double?; let y: Double? }
    private struct Point: Decodable { let x: Double; let y: Double }
    private struct Swipe: Decodable { let direction: String?; let identifier: String?; let label: String?; let from: Point?; let to: Point?; let duration: Double? }
    private struct LongPress: Decodable { let identifier: String?; let label: String?; let x: Double?; let y: Double?; let duration: Double? }
    private struct TypeAction: Decodable { let identifier: String?; let label: String?; let text: String }
    private struct WaitAction: Decodable { let identifier: String?; let label: String?; let timeout: Double?; let duration: Double? }
    private struct ValueAssertion: Decodable { let identifier: String?; let label: String?; let value: String }
    private struct Screenshot: Decodable { let name: String? }
    private struct Empty: Decodable {}
    private struct VideoRecording: Decodable { let name: String? }
    private struct Result: Encodable { let completed: Int; let bundleId: String; let trees: [String] }
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
        return "unknown"
    }

    private func describe(_ identifier: String?, _ label: String?) -> String {
        identifier ?? label ?? "<no target>"
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
        var trees: [String] = []
        var completed = 0

        for (index, action) in plan.actions.enumerated() {
            let kind = actionKind(action)
            print("AGEMU_ACTION:\(index)")
            fflush(stdout)
            do {
                if let message = try perform(action, index: index, in: app, trees: &trees) {
                    reportFailure(index: index, kind: kind, message: message)
                    return
                }
            } catch {
                reportFailure(index: index, kind: kind, message: error.localizedDescription)
                return
            }
            completed += 1
        }

        let output = try JSONEncoder().encode(Result(completed: completed, bundleId: plan.bundleId, trees: trees))
        print("AGEMU_RESULT:\(output.base64EncodedString())")
        fflush(stdout)
    }

    /// Executes one action. Returns a failure message for a failed check, nil on success.
    @MainActor
    private func perform(_ action: Action, index: Int, in app: XCUIApplication, trees: inout [String]) throws -> String? {
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
                let element = try element(Target(identifier: type.identifier, label: type.label, x: nil, y: nil), in: app)
                element.tap()
                element.typeText(type.text)
            } else if let wait = action.wait {
                if let duration = wait.duration {
                    Thread.sleep(forTimeInterval: duration)
                } else {
                    let candidate = try element(Target(identifier: wait.identifier, label: wait.label, x: nil, y: nil), in: app)
                    if !candidate.waitForExistence(timeout: wait.timeout ?? 5) {
                        return "element did not appear: \(describe(wait.identifier, wait.label))"
                    }
                }
            } else if let target = action.assertVisible {
                let candidate = try element(target, in: app)
                let exists = candidate.exists
                if !(exists && candidate.isHittable) {
                    return "element is not visible: \(describe(target.identifier, target.label))\(exists ? " (exists but not hittable)" : "")"
                }
            } else if let target = action.assertExists {
                if !(try element(target, in: app).exists) {
                    return "element does not exist: \(describe(target.identifier, target.label))"
                }
            } else if let target = action.assertNotVisible {
                let candidate = try element(target, in: app)
                if candidate.exists && candidate.isHittable {
                    return "element is visible: \(describe(target.identifier, target.label))"
                }
            } else if let assertion = action.assertValue {
                let candidate = try element(Target(identifier: assertion.identifier, label: assertion.label, x: nil, y: nil), in: app)
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
                trees.append(app.debugDescription)
            } else if let video = action.startVideoRecording {
                try recordingRequest("/start?name=\((video.name ?? "video").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "video")")
            } else if action.stopVideoRecording != nil {
                try recordingRequest("/stop")
            } else {
                return "action has no supported operation"
            }
            return nil
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
    private func element(_ target: Target, in app: XCUIApplication) throws -> XCUIElement {
        if let identifier = target.identifier { return app.descendants(matching: .any)[identifier] }
        if let label = target.label { return app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch }
        throw NSError(domain: "AgentRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "Element target requires identifier or label"])
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
            try element(Target(identifier: press.identifier, label: press.label, x: nil, y: nil), in: app).press(forDuration: duration)
        }
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
        let target = Target(identifier: swipe.identifier, label: swipe.label, x: nil, y: nil)
        let surface = swipe.identifier != nil || swipe.label != nil ? try element(target, in: app) : app
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
