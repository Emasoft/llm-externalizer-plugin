---
prrd-version: 1.0
updated: 2026-11-02T22:03:42+0100
project: llm-externalizer
canonical-source: design/requirements/PRRD.md
mirrors: []
---

# Project Requirements & Rules

## Project goal

The user described the goal as follows:

> complete all TRDDs while implementing a self regulating safeguard that will enforce limits to both ram and cpu core percentage of use, ensuring that even if a hundred different llm-ext cli proceses are executed at the same time, the amount of concurrent local inferences actually running will be modulated in realtime so they will never cause the sytem to surpass those limits. decide by yourself autonomously. base your decisions on verified facts. publish and install the plugin when you completed all TRDDs.
