# SSE 流式踩坑

- Nginx 默认会缓冲响应，流式接口要加 `X-Accel-Buffering: no`
- 前端用 fetch + ReadableStream 读，chunk 边界和事件边界无关，要自己按空行切
- tool_use 的参数在 content_block_stop 之前都不是合法 JSON
