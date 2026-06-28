---
name: ai-fortune-product-designer
description: Analyze product strategy, monetization, and design for AI-powered fortune-telling, metaphysics, astrology, personality, or fate/destiny consumer apps in the Chinese market. Use when the user is building or evaluating a product in the 算命/星座/玄学/MBTI/人格/命格 space.
station: global
kind: instruction
version: 1
---

# AI Fortune Product Designer

## Market Context

The Chinese metaphysics/fortune-telling consumer market is large, recurring, and deeply female-skewed:

- **Core audience:** Women 18-35, often educated, often in life transitions (career change, relationships, new city)
- **Occasion triggers:** Birth year/zodiac changes (春节), relationship decisions, job changes, exam seasons
- **Trust structure:** Users believe in the framework (Ba Zi, Zi Wei Dou Shu, tarot, MBTI) but are evaluating whether *this product* interprets it correctly
- **Repeat use:** Unlike most apps, fortune apps have natural multi-session triggers (new year, new month, major life events)

## Product Archetypes

**Type A — Daily companion (日历型)**
Daily fortune, affirmation, or mini-reading. Low engagement per session, high daily active rate. Monetization: subscription or ad. Risk: commodity, high churn if accuracy perception drops.

**Type B — Deep reading product (详批型)**
One-session comprehensive reading from birthdate/name/face photo. High WTP per session (¥9-68 typical). Monetization: pay-per-reading or freemium. Risk: one-and-done, hard to retain.

**Type C — Identity card / social product (分享型)**
Produces a beautiful shareable identity artifact. Viral acquisition. Monetization: upsell to detailed reading or subscription. Risk: novelty wears off, one viral moment.

**Type D — Relationship/compatibility product (关系型)**
Two-person compatibility, couple fortune, friendship match. Inherently social (needs a partner to use). Acquisition: shared link. Risk: asymmetric intent (one user sends, other ignores).

**Type E — AI companion with fortune layer (陪伴型)**
A relationship-like product where fortune-telling is the bonding mechanism, not the core product. High LTV, complex to build. Think: fortune-telling AI girlfriend/confidante.

## Positioning Framework

Before designing features, answer:
1. **What transition moment does this serve?** (Not「通用算命」— that's competitive hell)
2. **What belief system does it use?** (Ba Zi requires birthdate; tarot is session-based; MBTI is one-time)
3. **What does the user share?** (If nothing is shareable, acquisition cost is high forever)
4. **Is accuracy the product or is the ritual the product?** These require different design decisions

## Monetization Patterns (in order of proven effectiveness)

1. **Freemium deep reading**: Free short reading → paid full report (¥9-68). Highest immediate conversion for first session.
2. **Annual/monthly subscription**: Daily/weekly content. Works for daily-companion type. ¥18-88/month typical.
3. **Pay-per-question**: ¥1-9 per question after free quota. Works well for AI chat-based products.
4. **Virtual gifts to AI companion**: High ARPU, requires emotional attachment first.
5. **Course/community upsell**: 「学八字」course. High ticket, low volume, requires brand trust.

## AI Integration Principles

**What AI does well in this space:**
- Generating personalized narrative text from structured inputs (birthdate → story)
- Responding to follow-up questions about a reading
- Creating variety in daily content without repetition

**What AI does poorly:**
- Convincing users it「actually knows」if skepticism is high
- Maintaining consistency across sessions without memory
- Replacing the ritual feeling of a human master

**The accuracy perception problem:**
Users evaluate accuracy through narrative resonance, not fact-checking. A reading feels accurate when it:
- Names a real emotional experience the user has had
- Uses specific enough language (not「你会遇到贵人」but「今年秋天的人际变动对你来说是机遇」)
- Reflects back the user's identity in a flattering but believable way

**Design for 「说得真准！」moments:**
Every reading should have 1-2 lines that are specific enough to feel eerily accurate. These are the share triggers.

## Compliance and Risk

- Avoid claiming predictive accuracy about specific future events
- 算命 apps face platform review risk on iOS/Android — frame as「性格分析」「命理文化」not「预测」
- Financial fortune advice is regulated — stay in general life guidance
- Avoid cult-adjacent language or pressure tactics

## Competitive Moat Options

1. **System depth**: Most competitors use simple solar/lunar calendar. Ba Zi or Zi Wei requires data depth that's hard to replicate.
2. **Visual quality**: Beautiful identity cards are a moat if consistently better than competitors.
3. **Memory/personalization**: If the product remembers past readings and references them, switching cost increases.
4. **Community**: Fortune-sharing communities (「今天的运势……」) create content loop that drives retention.
