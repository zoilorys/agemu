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
        let assertValue: ValueAssertion?
        let screenshot: Screenshot?
        let inspect: Empty?
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
    private struct Result: Encodable { let completed: Int; let bundleId: String; let trees: [String] }

    @MainActor
    func testPlan() throws {
        let encoded = try XCTUnwrap(ProcessInfo.processInfo.environment["AGEMU_PLAN_BASE64"])
        let data = try XCTUnwrap(Data(base64Encoded: encoded))
        let plan = try JSONDecoder().decode(Plan.self, from: data)
        let app = XCUIApplication(bundleIdentifier: plan.bundleId)
        var trees: [String] = []

        for (index, action) in plan.actions.enumerated() {
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
                    XCTAssertTrue(candidate.waitForExistence(timeout: wait.timeout ?? 5), "Action \(index): element did not appear")
                }
            } else if let target = action.assertVisible {
                XCTAssertTrue(try element(target, in: app).exists, "Action \(index): element is not visible")
            } else if let assertion = action.assertValue {
                let candidate = try element(Target(identifier: assertion.identifier, label: assertion.label, x: nil, y: nil), in: app)
                XCTAssertEqual(candidate.value as? String, assertion.value, "Action \(index): element value does not match")
            } else if let shot = action.screenshot {
                let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                attachment.name = shot.name ?? "action-\(index)"
                attachment.lifetime = .keepAlways
                add(attachment)
            } else if action.inspect != nil {
                trees.append(app.debugDescription)
            } else {
                XCTFail("Action \(index) has no supported operation")
            }
        }

        let output = try JSONEncoder().encode(Result(completed: plan.actions.count, bundleId: plan.bundleId, trees: trees))
        print("AGEMU_RESULT:\(output.base64EncodedString())")
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
