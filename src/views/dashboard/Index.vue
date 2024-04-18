<!--项目起始页-->
<template>
  <div id="dashboard">
    <!-- 按需缓存需要缓存的页面，在router中设置router的元信息meta的keepAlive -->
    <keep-alive>
      <router-view v-if="$route.meta.keepAlive"></router-view>
    </keep-alive>
    <router-view v-if="!$route.meta.keepAlive"></router-view>
    <div id="tabbar">
      <van-tabbar v-model="active">
        <van-tabbar-item v-for="(item,index) in tabbars"
                         :id="item.name==='cart'?'shop-cart':''"
                         :info="item.name==='cart'?goodsNum:'' "
                         :icon="item.icon"
                         :badge="item.name==='friends'|| item.name==='message'?item.badge:''"
                         @click="handleTabClick(index,item.name)">

        </van-tabbar-item>
      </van-tabbar>
    </div>
  </div>
</template>

<script setup lang="ts">
import {useRouter} from "vue-router";

const tabbars = [
  {
    name: "home",
    title: '首页',
    icon: "wap-home"
  },
  {
    name: "friends",
    title: '朋友',
    icon: "friends-o",
    badge: "13"
  },
  {
    name: "add",
    title: '添加',
    icon: "plus"
  },
  {
    name: "message",
    title: '消息',
    icon: "chat-o",
    badge: "9"
  },
  {
    name: "user",
    title: '我的',
    icon: 'manager'
  }
];

const currentIndex = ref(0);
const active = ref(0);
const router = useRouter();

// tab点击切换页面
const handleTabClick = (index, tabName) => {
  currentIndex.value = index;
  router.push(tabName);
}
</script>