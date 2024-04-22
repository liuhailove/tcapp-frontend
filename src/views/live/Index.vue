<template>
  <van-row>
    <van-col span="4">
      <div class="video">
        <video width="600" height="350" autoplay="" playsinline=""></video>
      </div>
    </van-col>
    <van-col span="20">
      <div class="participant-area" id="participants-area"></div>
    </van-col>
  </van-row>
  <van-space style="margin-top: 2px">
    <van-button @click="appActions.connectWithFormInput()" type="primary" size="small">连接</van-button>
    <van-button @click="appActions.connectWithFormInput()" type="primary" size="small">加入</van-button>
    <van-button @click="appActions.toggleVideo()" type="primary" size="small">切换</van-button>
    <van-button @click="appActions.flipVideo()" type="primary" size="small">翻转</van-button>
    <van-button @click="appActions.startAudio()" type="primary" size="small">音频</van-button>
    <van-button @click="appActions.shareScreen()" type="primary" size="small">共享</van-button>
  </van-space>
  <!--  <div id="screenshare-area">-->
  <!--    <div>-->
  <!--      <span id="screenshare-info"> </span>-->
  <!--      <span id="screenshare-resolution"> </span>-->
  <!--    </div>-->
  <!--    <video id="screenshare-video" autoplay playsinline></video>-->
  <!--  </div>-->
  <!--  <div id="inputs-area">-->
  <!--    <div>-->
  <!--      <select-->
  <!--          id="video-input"-->
  <!--          class="custom-select"-->
  <!--          onchange="appActions.handleDeviceSelected(event)"-->
  <!--      >-->
  <!--        <option selected>Video Input (default)</option>-->
  <!--      </select>-->
  <!--    </div>-->
  <!--    <div>-->
  <!--      <select-->
  <!--          id="audio-input"-->
  <!--          class="custom-select"-->
  <!--          onchange="appActions.handleDeviceSelected(event)"-->
  <!--      >-->
  <!--        <option selected>Audio Input (default)</option>-->
  <!--      </select>-->
  <!--    </div>-->
  <!--    <div>-->
  <!--      <select-->
  <!--          id="audio-output"-->
  <!--          class="custom-select"-->
  <!--          onchange="appActions.handleDeviceSelected(event)"-->
  <!--      >-->
  <!--        <option selected>Audio Output (default)</option>-->
  <!--      </select>-->
  <!--    </div>-->
  <!--  </div>-->
  <div id="chat-area" style="height: 220px;">
    <van-field
        v-model="chat"
        rows="10"
        autosize
        type="textarea"
        readonly
    />
    <van-field
        v-model="myMsg"
        center
        clearable
        placeholder="说点什么"
    >
      <template #button>
        <van-button size="small" type="primary" @click="appActions.enterText()">发送</van-button>
      </template>
    </van-field>
  </div>
</template>
<script setup lang="ts">
import log, {LogLevel, setLogLevel} from "@/components/live_streams/logger";

import Room, {ConnectionState} from "@/components/live_streams/room/Room";
import {RoomConnectOptions, RoomOptions} from "@/components/live_streams/options";
import {ParticipantEvent, RoomEvent} from "@/components/live_streams/room/TrackEvents.ts";
import {ScreenSharePresets, VideoPresets} from "@/components/live_streams/room/track/options.ts";
import {AccessToken} from "@/components/live_streams/token/AccessToken.ts";
import Participant, {ConnectionQuality} from "@/components/live_streams/room/participant/Participant.ts";
import {TrackPublication} from "@/components/live_streams/room/track/TrackPublication.ts";
import RemoteParticipant from "@/components/live_streams/room/participant/RemoteParticipant.ts";
import {ExternalE2EEKeyProvider} from "@/components/live_streams/e2ee";
import LocalParticipant from "@/components/live_streams/room/participant/LocalParticipant.ts";
import {Track} from "@/components/live_streams/room/track/Track.ts";
import {DisconnectReason} from "@/components/live_streams/protocol/tc_models_pb.ts";
import RemoteTrackPublication from "@/components/live_streams/room/track/RemoteTrackPublication.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const chat = ref("");
const myMsg = ref("");

let startTime: number = 0;

// 当前房间
let currentRoom: Room | undefined;

// 设置日志级别
setLogLevel(LogLevel.debug);
// 全局定义
declare global {
  interface Window {
    currentRoom: any;
    appActions: typeof appActions;
  }
}
// 状态
const state = {
  isFrontFacing: false,
  encoder: new TextEncoder(),
  decoder: new TextDecoder(),
  defaultDevices: new Map<MediaDeviceKind, string>(),
  bitrateInterval: undefined as any,
  e2eeKeyProvider: new ExternalE2EEKeyProvider(),
};

// 定义当前app
const appActions = {

  connectWithFormInput: async () => {
    const url = "ws://localhost:7880";
    const t = new AccessToken("devkey", "secret", {
      identity: 'me',
      name: 'myname',
    });
    t.addGrant({
      roomCreate: true,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      room: "myroom",
    });
    const token = (await (t.toJwt())).toString();
    log.info("toJwt" + token);
    const adaptiveStream = false;
    const simulcast = false;
    const dynacast = false;
    // 房间配置
    const roomOpts: RoomOptions = {
      adaptiveStream,
      dynacast,
      audioOutput: {
        deviceId: "",
      },

      publishDefaults: {
        simulcast,
        videoSimulcastLayers: [VideoPresets.h90, VideoPresets.h216],
        videoCodec: 'vp8',
        dtx: true,
        red: true,
        forceStereo: false,
        screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
      },
      videoCaptureDefaults: {
        resolution: VideoPresets.h720.resolution,
      },
      e2ee: undefined,
    };
    // 链接配置
    const connectOpts: RoomConnectOptions = {
      autoSubscribe: true,
    };
    await appActions.connectToRoom(url, token, roomOpts, connectOpts, true);
    // state.bitrateInterval = setInterval(renderBitrate, 1000);
  },

  /**
   * 连接到房间
   * @param url 远程地址
   * @param token token
   * @param roomOptions 房间选项
   * @param connectOptions 连接选项
   * @param shouldPublish 是否发布
   * @return 构造的房间
   */
  connectToRoom: async (
      url: string,
      token: string,
      roomOptions?: RoomOptions,
      connectOptions?: RoomConnectOptions,
      shouldPublish?: boolean,
  ): Promise<Room | undefined> => {
    // 根据房间参数创建房间
    log.debug("enter connectToRoom");
    const room = new Room(roomOptions);
    // 记录房间创建事件
    startTime = Date.now();
    // 和Server进行交互
    await room.prepareConnection(url, token);
    // 预热时间
    const preWarmTime = Date.now() - startTime;
    log.debug("preWarmed connection in " + preWarmTime + " ms");
    // 设置事件
    room.on(RoomEvent.ParticipantConnected, participantConnected)
        .on(RoomEvent.ParticipantDisconnected, participantDisconnected)
        .on(RoomEvent.DataReceived, handleData)
        .on(RoomEvent.Disconnected, handleRoomDisconnect)
        .on(RoomEvent.Reconnecting, () => {
          log.info("Reconnecting to Room");
        })
        .on(RoomEvent.Reconnected, () => log.info("Successfully reconnected. server=" + (room.engine.getConnectedServerAddress())))
        .on(RoomEvent.Connected, () => {
          log.debug('Connected to Server');
        })
        .on(RoomEvent.SignalConnected, async () => {
          const signalConnectionTime = Date.now() - startTime;
          log.info(`signal connection established in ${signalConnectionTime} ms`);
          if (shouldPublish) {
            log.info(`shouldPublish enableCameraAndMicrophone`);
            await room.localParticipant.enableCameraAndMicrophone();
            log.info(`tracks published in ${Date.now() - startTime} ms`);
          }
        });
    try {
      await room.connect(url, token, connectOptions);
      const elapsed = Date.now() - startTime;
      log.debug(`successfully connected to ${room.name} in ${Math.round(elapsed)} ms,` + (await room.engine.getConnectedServerAddress()));
    } catch (error: any) {
      let message: any = error;
      if (error.message) {
        message = error.message;
      }
      log.error('could not connect:' + message);
      return;
    }
    // 房间赋值
    currentRoom = room;
    // window对象赋值
    window.currentRoom = room;

    // 参与者加入到房间
    room.remoteParticipants.forEach((participant) => {
      participantConnected(participant);
    });
    participantConnected(room.localParticipant);
    return room;
  },
  enterText: () => {
    log.debug('enterText');
    if (!currentRoom) {
      return;
    }
    if (myMsg.value) {
      const msg = state.encoder.encode(myMsg.value);
      currentRoom.localParticipant.publishData(msg, {reliable: true});
      chat.value += `${currentRoom.localParticipant.identity} (me):${myMsg.value}\n`;
      myMsg.value = '';
    }
  },
}

/**
 * 有参与者连接到房间
 * @param participant 参与者
 */
function participantConnected(participant: Participant) {
  log.info('participantConnected, identity=' + participant.identity + ", connected=" + participant.metadata);
  chat.value += `${participant.identity}(From):来了\n`;
  participant
      .on(ParticipantEvent.TrackMuted, (pub: TrackPublication) => {
        chat.value += `track was muted, ${pub.trackSid}, ${participant.identity}\n`;
        renderParticipant(participant);
      })
      .on(ParticipantEvent.TrackUnmuted, (pub: TrackPublication) => {
        chat.value += `track was unmuted, ${pub.trackSid}, ${participant.identity}\n`;
        renderParticipant(participant);
      })
      .on(ParticipantEvent.IsSpeakingChanged, () => {
        renderParticipant(participant);
      })
      .on(ParticipantEvent.ConnectionQualityChanged, () => {
        renderParticipant(participant);
      });
}

/**
 * 参与者断开连接
 */
function participantDisconnected(participant: RemoteParticipant) {
  chat.value += `participant, ${participant.sid} disconnected\n`;

  renderParticipant(participant, true);
}

// --------------------------- event handlers ------------------------------- //
function handleData(msg: Uint8Array, participant?: RemoteParticipant) {
  const str = state.decoder.decode(msg);
  let from = 'server';
  if (participant) {
    from = participant.identity;
  }
  chat.value += `${from}:${str}`;
}

// 更新参与者UI
function renderParticipant(participant: Participant, remove: boolean = false) {
  // 获取参与者面板div
  const container = $('participants-area');
  if (!container) {
    return;
  }
  // 参与者标识
  const {identity} = participant;
  let div = $(`participant-${identity}`);
  if (!div && !remove) {
    div = document.createElement('div');
    div.id = `participant-${identity}`;
    div.className = 'participant';
    div.innerHTML = `
      <video id="video-${identity}"></video>
      <audio id="audio-${identity}"></audio>
      <div class="info-bar">
        <div id="name-${identity}" class="name">
        </div>
        <div style="text-align: center;">
          <span id="codec-${identity}" class="codec">
          </span>
          <span id="size-${identity}" class="size">
          </span>
          <span id="bitrate-${identity}" class="bitrate">
          </span>
        </div>
        <div class="right">
          <span id="signal-${identity}"></span>
          <span id="mic-${identity}" class="mic-on"></span>
          <span id="e2ee-${identity}" class="e2ee-on"></span>
        </div>
      </div>
      ${participant instanceof RemoteParticipant ?
        `<div class="volume-control"> <input id="volume-${identity}" type="range" min="0" max="1" step="0.1" value="1" orient="vertical" /></div>`
        : `<progress id="local-volume" max="1" value="0" />`
    }`;
    container.appendChild(div);

    const sizeElm = $(`size-${identity}`);
    const videoElm = <HTMLVideoElement>$(`video-${identity}`);
    videoElm.onresize = () => {
      updateVideoSize(videoElm!, sizeElm!);
    };
  }
  const videoElm = <HTMLVideoElement>$(`video-${identity}`);
  const audioELm = <HTMLAudioElement>$(`audio-${identity}`);
  if (remove) {
    div?.remove();
    if (videoElm) {
      videoElm.srcObject = null;
      videoElm.src = '';
    }
    if (audioELm) {
      audioELm.srcObject = null;
      audioELm.src = '';
    }
    return;
  }

  // update properties
  $(`name-${identity}`)!.innerHTML = participant.identity;
  if (participant instanceof LocalParticipant) {
    $(`name-${identity}`)!.innerHTML += ' (you)';
  }
  const micElm = $(`mic-${identity}`)!;
  const signalElm = $(`signal-${identity}`)!;
  const cameraPub = participant.getTrackPublication(Track.Source.Camera);
  const micPub = participant.getTrackPublication(Track.Source.Microphone);
  if (participant.isSpeaking) {
    div!.classList.add('speaking');
  } else {
    div!.classList.remove('speaking');
  }

  if (participant instanceof RemoteParticipant) {
    const volumeSlider = <HTMLInputElement>$(`volume-${identity}`);
    volumeSlider.addEventListener('input', (ev) => {
      participant.setVolume(Number.parseFloat((ev.target as HTMLInputElement).value));
    });
  }

  const cameraEnabled = cameraPub && cameraPub.isSubscribed && !cameraPub.isMuted;
  if (cameraEnabled) {
    if (participant instanceof LocalParticipant) {
      // flip
      videoElm.style.transform = 'scale(-1, 1)';
    } else if (!cameraPub?.videoTrack?.attachedElements.includes(videoElm)) {
      const renderStartTime = Date.now();
      // measure time to render
      videoElm.onloadeddata = () => {
        const elapsed = Date.now() - renderStartTime;
        let fromJoin = 0;
        if (participant.joinedAt && participant.joinedAt.getTime() < startTime) {
          fromJoin = Date.now() - startTime;
        }
        console.info(
            `RemoteVideoTrack ${cameraPub?.trackSid} (${videoElm.videoWidth}x${videoElm.videoHeight}) rendered in ${elapsed}ms`,
            fromJoin > 0 ? `, ${fromJoin}ms from start` : '',
        );
      };
    }
    cameraPub?.videoTrack?.attach(videoElm);
  } else {
    // clear information display
    $(`size-${identity}`)!.innerHTML = '';
    if (cameraPub?.videoTrack) {
      // detach manually whenever possible
      cameraPub.videoTrack?.detach(videoElm);
    } else {
      videoElm.src = '';
      videoElm.srcObject = null;
    }
  }

  const micEnabled = micPub && micPub.isSubscribed && !micPub.isMuted;
  if (micEnabled) {
    if (!(participant instanceof LocalParticipant)) {
      // don't attach local audio
      audioELm.onloadeddata = () => {
        if (participant.joinedAt && participant.joinedAt.getTime() < startTime) {
          const fromJoin = Date.now() - startTime;
          console.info(`RemoteAudioTrack ${micPub?.trackSid} played ${fromJoin}ms from start`);
        }
      };
      micPub?.audioTrack?.attach(audioELm);
    }
    micElm.className = 'mic-on';
    micElm.innerHTML = '<i class="fas fa-microphone"></i>';
  } else {
    micElm.className = 'mic-off';
    micElm.innerHTML = '<i class="fas fa-microphone-slash"></i>';
  }

  const e2eeElm = $(`e2ee-${identity}`)!;
  if (participant.isEncrypted) {
    e2eeElm.className = 'e2ee-on';
    e2eeElm.innerHTML = '<i class="fas fa-lock"></i>';
  } else {
    e2eeElm.className = 'e2ee-off';
    e2eeElm.innerHTML = '<i class="fas fa-unlock"></i>';
  }

  switch (participant.connectionQuality) {
    case ConnectionQuality.Excellent:
    case ConnectionQuality.Good:
    case ConnectionQuality.Poor:
      signalElm.className = `connection-${participant.connectionQuality}`;
      signalElm.innerHTML = '<i class="fas fa-circle"></i>';
      break;
    default:
      signalElm.innerHTML = '';
      // do nothing
  }
}

/**
 * 更新视频大小
 * @param element 媒体元素
 * @param target 目标
 */
function updateVideoSize(element: HTMLVideoElement, target: HTMLElement) {
  target.innerHTML = `(${element.videoWidth}x${element.videoHeight})`;
}

/**
 * 处理房间断开连接
 * @param reason 断开连接的原因
 */
function handleRoomDisconnect(reason?: DisconnectReason) {
  if (!currentRoom) {
    return;
  }
  log.info(`disconnected from room, ${reason}`);
  renderParticipant(currentRoom.localParticipant, true);
  currentRoom.remoteParticipants.forEach((p) => {
    renderParticipant(p, true);
  });
  renderScreenShare(currentRoom);
  const container = $('participants-area');
  if (container) {
    container.innerHTML = '';
  }
  // 断开连接后清空聊天狂
  chat.value = '';
  currentRoom = undefined;
  window.currentRoom = undefined;
}

/**
 * 渲染屏幕共享
 * @param room 当前房间
 */
function renderScreenShare(room: Room) {
  const div = $('screenshare-area')!;
  if (room.state !== ConnectionState.Connected) {
    div.style.display = 'none';
    return;
  }
  let participant: Participant | undefined;
  let screenSharePub: TrackPublication | undefined = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
  );
  let screenShareAudioPub: RemoteTrackPublication | undefined;
  if (!screenSharePub) {
    room.remoteParticipants.forEach((p) => {
      if (screenSharePub) {
        return;
      }
      participant = p;
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (pub?.isSubscribed) {
        screenSharePub = pub;
      }
      const audioPub = p.getTrackPublication(Track.Source.ScreenShareAudio);
      if (audioPub?.isSubscribed) {
        screenShareAudioPub = audioPub;
      }
    });
  } else {
    participant = room.localParticipant;
  }

  if (screenSharePub && participant) {
    div.style.display = 'block';
    const videoElm = <HTMLVideoElement>$('screenshare-video');
    if (screenShareAudioPub) {
      screenShareAudioPub.audioTrack?.attach(videoElm);
    }
    videoElm.onresize = () => {
      updateVideoSize(videoElm, <HTMLSpanElement>$('screenshare-resolution'));
    };
    const infoElm = $('screenshare-info')!;
    infoElm.innerHTML = `Screenshare from ${participant.identity}`;
  } else {
    div.style.display = 'none';
  }
}


</script>
<style>
#connect-area {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: min-content min-content;
  grid-auto-flow: column;
  grid-gap: 10px;
  margin-bottom: 15px;
}

#options-area {
  display: flex;
  flex-wrap: wrap;
  margin-left: 1.25rem;
  margin-right: 1.25rem;
  column-gap: 3rem;
  row-gap: 1rem;
  margin-bottom: 10px;
}

#actions-area {
  display: grid;
  grid-template-columns: fit-content(100px) auto;
  grid-gap: 1.25rem;
  margin-bottom: 15px;
}

#inputs-area {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-gap: 1.25rem;
  margin-bottom: 10px;
}

#chat-input-area {
  margin-top: 1.2rem;
  display: grid;
  grid-template-columns: auto min-content;
  gap: 1.25rem;
}

#screenshare-area {
  position: relative;
  margin-top: 1.25rem;
  margin-bottom: 1.25rem;
  display: none;
}

#screenshare-area video {
  max-width: 300px;
  max-height: 300px;
  border: 3px solid rgba(0, 0, 0, 0.5);
}

#participants-area {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
}

#participants-area > .participant {
  width: 80%;
}

#participants-area > .participant::before {
  content: '';
  display: inline-block;
  width: 1px;
  height: 0;
  padding-bottom: calc(100% / (16 / 9));
}

#log-area {
  margin-top: 1.25rem;
  margin-bottom: 1rem;
}

#log {
  width: 66.6%;
  height: 100px;
}

.participant {
  position: relative;
  padding: 0;
  margin: 0;
  border-radius: 5px;
  border: 3px solid rgba(0, 0, 0, 0);
  overflow: hidden;
}

.participant video {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: #aaa;
  object-fit: cover;
  border-radius: 5px;
}

.participant .info-bar {
  position: absolute;
  width: 100%;
  bottom: 0;
  display: grid;
  color: #eee;
  padding: 2px 8px 2px 8px;
  background-color: rgba(0, 0, 0, 0.35);
  grid-template-columns: minmax(50px, auto) 1fr minmax(50px, auto);
  z-index: 5;
}

.participant .size {
  text-align: center;
}

.participant .right {
  text-align: right;
}

.participant.speaking {
  border: 3px solid rgba(94, 166, 190, 0.7);
}

.participant .mic-off {
  color: #d33;
  text-align: right;
}

.participant .mic-on {
  text-align: right;
}

.participant .connection-excellent {
  color: green;
}

.participant .connection-good {
  color: orange;
}

.participant .connection-poor {
  color: red;
}

.participant .volume-control {
  position: absolute;
  top: 4px;
  right: 2px;
  display: flex;
  z-index: 4;
  height: 100%;
}

.participant .volume-control > input {
  width: 16px;
  height: 40%;
  writing-mode: vertical-lr;
  direction: rtl;
}

.participant .volume-meter {
  position: absolute;
  z-index: 4;
}
</style>