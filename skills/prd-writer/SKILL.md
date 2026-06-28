---
name: prd-writer
description: Convert an idea direction card, open questions, or rough brief into a structured Chinese startup PRD. Use when the user asks to write a product requirements document, product spec, feature spec, or needs to turn auto-pilot output into a PRD.
station: global
kind: instruction
version: 1
---

# PRD Writer

## Purpose

Turn a vague direction or auto-pilot brief into a usable product requirements document for Chinese startup context. Optimize for clarity over completeness — a 6-section PRD that can be handed to a developer or investor is better than a 20-section template nobody reads.

## Input

Accept any of: direction card text, open questions list, raw brief, or a combination. If only a brief is given, infer the likely target user, core action, and success metric from context.

## Output Structure

Always produce these six sections in Chinese:

```
# PRD：[产品名称]

## 一句话定义
[产品是什么 + 为谁解决什么问题，30字以内]

## 目标用户
- 核心用户：[具体描述，有人口特征、场景、痛点]
- 非目标用户：[明确排除哪些人，减少范围蔓延]

## 核心功能（MVP）
按优先级列，每条格式：**功能名** — 用户能做什么 → 产生什么结果
P0（必须有）:
- ...
P1（第二版）:
- ...

## 不做的事
- [功能/场景，说明为什么暂时不做]

## 成功指标
- 上线30天：[可测量指标，带具体数字假设]
- 90天：[留存/商业化指标]

## 关键依赖和风险
- [技术/供应商/合规/市场时机风险，每条一句话]
```

## Writing Rules

- 核心功能用动词开头，每条聚焦「用户做什么」而不是「系统实现什么」
- 成功指标必须可量化，禁用「用户满意度提升」这类无法测量的表述
- 非目标用户是最容易被跳过、最容易导致产品失焦的部分，必须填写
- 如果 open_questions 里有争议项，在「关键依赖和风险」里标注，不要假装已经解决
- 语言风格：直接、简短、能在手机上读完

## Common Mistakes to Avoid

- 不要写「AI 驱动」「数据智能」等空洞技术词汇，除非用户已确认技术方案
- 不要把「用户反馈」「持续优化」写进 MVP 功能，那是运营动作不是产品功能
- 不要把竞品分析写进 PRD 正文，竞品分析是另一个文档
