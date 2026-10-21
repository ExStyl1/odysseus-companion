pluginManagement {
  val gradleIntellijPluginVersion: String by settings

  plugins {
    id("org.jetbrains.intellij.platform") version gradleIntellijPluginVersion apply false
    id("org.jetbrains.intellij.platform.module") version gradleIntellijPluginVersion apply false
  }

  repositories {
    maven("https://nexus.tcsbank.ru/repository/gradle-plugins/")
  }
}

rootProject.name = "nessy-intellij-ide-companion"
