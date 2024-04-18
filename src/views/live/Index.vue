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
    <van-button @click="myAppActions.connectWithFormInput()" type="primary" size="small">连接</van-button>
    <van-button @click="myAppActions.connectWithFormInput()" type="primary" size="small">加入</van-button>
    <van-button @click="myAppActions.toggleVideo()" type="primary" size="small">切换</van-button>
    <van-button @click="myAppActions.flipVideo()" type="primary" size="small">翻转</van-button>
    <van-button @click="myAppActions.startAudio()" type="primary" size="small">音频</van-button>
    <van-button @click="myAppActions.shareScreen()" type="primary" size="small">共享</van-button>
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
        <van-button size="small" type="primary" @click="myAppActions.enterText()">发送</van-button>
      </template>
    </van-field>
  </div>
</template>
<script setup lang="ts">
import Room from "@/components/live_streams/room/Room";
import {RoomConnectOptions, RoomOptions} from "@/components/live_streams/options";

const chat = markRaw("");
const myMsg = markRaw("");

// 当前房间
let currentRoom: Room | undefined;

// 定义当前app
const myApplications = {

  connectToRoom: async (
      url: string,
      token: string,
      roomOptions?: RoomOptions,
      connectOptions?: RoomConnectOptions,
      shouldPublish?: boolean,
  ): Promise<Room | undefined> => {
    // 根据房间参数创建房间
    const room=new Room(roomOptions);
  }
};


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