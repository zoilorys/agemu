import XCTest

final class AgentRunner: XCTestCase {
    private struct Plan: Decodable { let bundleId: String; let actions: [Action] }
    private struct Action: Decodable {
        let launch: Launch?
        let tap: Target?
        let type: TypeAction?
        let wait: WaitAction?
        let assertVisible: Target?
        let assertValue: ValueAssertion?
        let screenshot: Screenshot?
        let inspect: Empty?
    }
    private struct Launch: Decodable { let arguments: [String]?; let environment: [String: String]? }
    private struct Target: Decodable { let identifier: String?; let label: String?; let x: Double?; let y: Double? }
    private struct TypeAction: Decodable { let identifier: String?; let label: String?; let text: String }
    private struct WaitAction: Decodable { let identifier: String?; let label: String?; let timeout: Double? }
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
            } else if let type = action.type {
                let element = try element(Target(identifier: type.identifier, label: type.label, x: nil, y: nil), in: app)
                element.tap()
                element.typeText(type.text)
            } else if let wait = action.wait {
                let candidate = try element(Target(identifier: wait.identifier, label: wait.label, x: nil, y: nil), in: app)
                XCTAssertTrue(candidate.waitForExistence(timeout: wait.timeout ?? 5), "Action \(index): element did not appear")
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
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
        } else {
            try element(target, in: app).tap()
        }
    }
}
