# webapp 文案与 i18n

- 新文案走 内部平台 的 i18n 项目，key 按 模块.页面.用途 命名
- 不要在组件里写死中文，lint 会报 no-literal-string
- 复数和占位符用 ICU 语法：{count, plural, one {# file} other {# files}}
