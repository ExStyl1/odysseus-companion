import properties

plugins {
  kotlin("jvm") version "2.3.0"
  id("org.jetbrains.intellij.platform") version "2.10.5"
  id("dev.bmac.intellij.plugin-uploader") version "1.3.5"
}

group = properties("pluginGroup").get()
version = properties("pluginVersion").get()

repositories {
  maven("https://nexus.tcsbank.ru/repository/mvn-proxy-google-release/")
  maven("https://nexus.tcsbank.ru/repository/mvn-maven-proxy/")
  maven("https://artifactory.tcsbank.ru/artifactory/maven-all/")
  intellijPlatform {
    defaultRepositories()
  }
}

dependencies {
  implementation("com.google.code.gson:gson:2.11.0")
  intellijPlatform {
    val intellijPath = properties("intellijPlatformPath").orNull
    if (intellijPath != null) {
      local(file(intellijPath))
    } else {
      create(properties("platformType"), properties("platformVersion"))
    }
    bundledPlugins("com.intellij.java")
  }
}

intellijPlatform {
  // Модуль на чистом Kotlin: нет ни .form-файлов GUI Designer, ни @NotNull из
  // org.jetbrains.annotations, так что инструментировать нечего. Зато включённая
  // инструментация тянет com.jetbrains.intellij.java:java-compiler-ant-tasks
  // с cache-redirector.jetbrains.com по диапазону версий и вешает :instrumentCode в CI.
  instrumentCode = false

  pluginConfiguration {
    id.set(properties("pluginId").get())
    name.set(properties("pluginName").get())
    version.set(project.version.toString())
    ideaVersion {
      sinceBuild.set(properties("sinceBuild").get())
      untilBuild = provider { null }
    }
  }
}

kotlin {
  jvmToolchain(17)
}

tasks {
  val repoRoot = project.projectDir.parentFile?.parentFile
    ?: throw GradleException("Cannot resolve repo root from ${project.projectDir}")
  val webviewSource = repoRoot.resolve("packages/vscode-ide-companion/dist/webview.js")
  val webviewTargetDir = project.layout.projectDirectory.dir("src/main/resources/webview")
  val assetsSourceDir = repoRoot.resolve("packages/vscode-ide-companion/assets")
  val assetsTargetDir = project.layout.projectDirectory.dir("src/main/resources/assets")
  val cliSourceDir = repoRoot.resolve("packages/vscode-ide-companion/dist/nessy-cli")
  val cliTargetDir = project.layout.projectDirectory.dir("src/main/resources/cli")

  val syncWebview by registering(Copy::class) {
    from(webviewSource)
    into(webviewTargetDir)
    doFirst {
      if (!webviewSource.exists()) {
        logger.warn("webview.js not found at ${webviewSource.path}. Run the VSCode webview build.")
      }
    }
  }

  val syncAssets by registering(Copy::class) {
    from(assetsSourceDir)
    into(assetsTargetDir)
    doFirst {
      if (!assetsSourceDir.exists()) {
        logger.warn("Webview assets not found at ${assetsSourceDir.path}.")
      }
    }
  }

  val syncCli by registering {
    doLast {
      if (!cliSourceDir.exists()) {
        logger.warn("CLI bundle not found at ${cliSourceDir.path}. Run the VSCode extension build.")
        return@doLast
      }
      copy {
        from(cliSourceDir)
        into(cliTargetDir)
      }
      logger.info("Copied CLI bundle to ${cliTargetDir.asFile.path}")
    }
  }

  named("processResources") {
    dependsOn(syncWebview)
    dependsOn(syncAssets)
    dependsOn(syncCli)
  }

  named("prepareSandbox") {
    dependsOn(syncWebview)
    dependsOn(syncAssets)
    dependsOn(syncCli)
  }

  named("runIde") {
    dependsOn(syncWebview)
    dependsOn(syncAssets)
    dependsOn(syncCli)
  }

  register<dev.bmac.gradle.intellij.UpdateXmlTask>("updateLocalPluginXml") {
    val pluginVersion = properties("pluginVersion").get()
    val pluginArchiveBaseName = properties("pluginArchiveBaseName").get()
    
    // Для stable release извлекаем версию из тега (например, release-cli-0.11.0 -> 0.11.0)
    // Если тег содержит -beta, используем версию из gradle.properties
    val ciCommitTag = System.getenv("CI_COMMIT_TAG")
    val resolvedVersion = if (ciCommitTag != null && ciCommitTag.matches(Regex("^release-[a-z]+-[0-9]+\\.[0-9]+\\.[0-9]+$"))) {
      ciCommitTag.substringAfterLast("-")
    } else {
      pluginVersion
    }
    
    updateFile.set(file(properties("updatePluginXmlPath")))
    downloadUrl.set("https://s3-msk.tinkoff.ru/nestor-companion/release/jetbrains/$pluginArchiveBaseName-$resolvedVersion.zip")
    pluginName.set(properties("pluginName").get())
    pluginId.set(properties("pluginId").get())
    version.set(resolvedVersion)
    sinceBuild.set(properties("sinceBuild"))
  }

  named("buildPlugin") {
    if (this is org.jetbrains.intellij.platform.gradle.tasks.BuildPluginTask) {
      archiveBaseName.set(properties("pluginArchiveBaseName").get())
    }
  }
}

fun properties(key: String) = providers.gradleProperty(key)
