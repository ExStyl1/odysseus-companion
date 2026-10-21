package org.nessy.intellij.types

class UsageStatsPayload(
    val usage: UsageStats? = null,
    val durationMs: Long? = null,
    val tokenLimit: Int? = null
)

class UsageStats(
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
    val thoughtsTokens: Int? = null,
    val totalTokens: Int? = null,
    val cachedTokens: Int? = null
)

class ModelInfo(
    val modelId: String? = null,
    val name: String? = null,
    val _meta: Map<String, Any>? = null
)