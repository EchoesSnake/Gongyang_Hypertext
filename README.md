# Gongyang Hypertext Prototype

一个无需构建工具的单页原型，复刻 annotated hypertext edition 的核心交互：

- 正文词条超链接（`[[annotation_id|显示文本]]`）
- 右侧注释面板（查看、编辑、删除、关联词条）
- 正文段落编辑（直接改标记语法）
- 本地持久化（`localStorage`）
- JSON 导入 / 导出（可作为后续后端接口格式雏形）

## 运行方式

1. 直接用浏览器打开 `index.html`
2. 或在目录下起一个静态服务后访问页面

## 数据结构

`app.js` 里的 `seedCorpus` 结构：

```json
{
  "sections": [
    {
      "id": "yin-1",
      "title": "隐公元年",
      "paragraphs": [
        { "id": "yin-1-p1", "text": "元年春，[[wang_zheng_yue|王正月]]。" }
      ]
    }
  ],
  "annotations": {
    "wang_zheng_yue": {
      "id": "wang_zheng_yue",
      "title": "王正月",
      "body": "注释正文",
      "tags": ["义例"],
      "links": ["san_yue"]
    }
  }
}
```

## 后续可扩展

1. 把 `localStorage` 改为后端 API（Flask/FastAPI + SQLite/Postgres）
2. 增加用户系统与版本历史（注释修订记录）
3. 增加段落级讨论、审校流（draft/published）
4. 接入全文检索（Elasticsearch / Meilisearch）
