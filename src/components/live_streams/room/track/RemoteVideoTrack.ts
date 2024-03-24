import {Track} from "./Track";
import RemoteTrack from "./RemoteTrack";
import {SignalClient} from "../../api/SignalClient";

export default class RemoteVideoTrack extends RemoteTrack<Track.Kind.Video> {
    startMonitor(signalClient: SignalClient | undefined): void {
    }

}