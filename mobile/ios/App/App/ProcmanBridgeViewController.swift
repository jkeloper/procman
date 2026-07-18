import Capacitor

@objc(ProcmanBridgeViewController)
final class ProcmanBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PinnedTransportPlugin())
    }
}
