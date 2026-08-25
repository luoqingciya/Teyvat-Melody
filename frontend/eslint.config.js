import vue from "eslint-plugin-vue";

export default [
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // 浏览器渲染进程代码：undefined 由 Vite/Rollup 在构建期兜底，这里关闭避免全局白名单噪音；
      // 未使用变量/导入与 debugger 仍保留，是我们要抓的纯净度问题。
      "no-unused-vars": "error",
      "no-undef": "off",
      "no-debugger": "error",
      "no-console": "off",
    },
  },
  ...vue.configs["flat/essential"],
  {
    files: ["**/*.vue"],
    rules: {
      // script setup 里模板引用、未使用导入等由 vue 插件模板感知地识别。
      "vue/no-unused-vars": "error",
      // 单字组件名（如 Sidebar）是本项目的既有命名，关闭该命名规则。
      "vue/multi-word-component-names": "off",
    },
  },
];
