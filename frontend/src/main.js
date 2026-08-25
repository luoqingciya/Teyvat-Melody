import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import router from "./router";
import AppIcon from "./components/AppIcon.vue";
import { piniaPersist } from "./plugins/piniaPersist";
import "./assets/styles/global.css";

const pinia = createPinia();
pinia.use(piniaPersist);

const app = createApp(App);
app.use(pinia);
app.use(router);
app.component("AppIcon", AppIcon); // 全局图标组件
app.mount("#app");