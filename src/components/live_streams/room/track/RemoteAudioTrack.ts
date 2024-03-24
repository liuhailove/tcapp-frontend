import RemoteTrack from "./RemoteTrack";
import {Track} from "./Track";
import {SignalClient} from "../../api/SignalClient";

export default class RemoteAudioTrack extends RemoteTrack<Track.Kind.Audio> {
    startMonitor(signalClient: SignalClient | undefined): void {
    }

}