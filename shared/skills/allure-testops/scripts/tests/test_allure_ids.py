import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "allure_ids.py"
SPEC = importlib.util.spec_from_file_location("allure_ids", SCRIPT_PATH)
allure_ids = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(allure_ids)


class ScanTests(unittest.TestCase):
    def test_scans_kotlin_backtick_test(self):
        content = '''package ru.test

import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

class OfferStatisticsTest {
    @Test
    @DisplayName("офферы разделяются по ecosystem id")
    fun `offers are separated`() = Unit
}
'''

        tests = allure_ids.scan_content(content, Path("OfferStatisticsTest.kt"))

        self.assertEqual(1, len(tests))
        self.assertEqual("offers are separated", tests[0].methodName)
        self.assertEqual("офферы разделяются по ecosystem id", tests[0].name)
        self.assertEqual("ru.test.OfferStatisticsTest.offers are separated", tests[0].fullName)
        self.assertEqual(7, tests[0].testLine)

    def test_scans_java_test_and_existing_id(self):
        content = '''package ru.test;

import org.junit.jupiter.api.Test;

class OfferTest {
    @Test
    @AllureId("42")
    void separatesOffers() {}
}
'''

        tests = allure_ids.scan_content(content, Path("OfferTest.java"))

        self.assertEqual("separatesOffers", tests[0].methodName)
        self.assertEqual("42", tests[0].allureId)
        self.assertEqual("ru.test.OfferTest.separatesOffers", tests[0].fullName)

    def test_ignores_test_factory(self):
        content = '''class DynamicTest {
    @TestFactory
    fun cases() = emptyList<Any>()
}
'''

        self.assertEqual([], allure_ids.scan_content(content, Path("DynamicTest.kt")))

    def test_scans_multiline_display_name_with_parenthesis(self):
        content = '''class OfferTest {
    @Test
    @DisplayName(
        "возвращает результат (OK)"
    )
    fun result() = Unit
}
'''

        tests = allure_ids.scan_content(content, Path("OfferTest.kt"))

        self.assertEqual("возвращает результат (OK)", tests[0].name)

    def test_rejects_unsupported_file(self):
        with self.assertRaisesRegex(ValueError, "только .kt и .java"):
            allure_ids.scan_content("@Test", Path("test.py"))


class ApplyTests(unittest.TestCase):
    def test_applies_annotation_and_kotlin_import(self):
        content = '''package ru.test

import org.junit.jupiter.api.Test

class OfferTest {
    @Test
    fun `separates offers`() = Unit
}
'''

        updated = allure_ids.render_change(
            content,
            Path("OfferTest.kt"),
            "separates offers",
            "8068313",
            6,
        )

        self.assertIn("import io.qameta.allure.AllureId\n", updated)
        self.assertIn('@Test\n    @AllureId("8068313")\n', updated)
        self.assertLess(
            updated.index("import io.qameta.allure.AllureId"),
            updated.index("import org.junit.jupiter.api.Test"),
        )

    def test_applies_java_import_with_semicolon(self):
        content = '''package ru.test;

import org.junit.jupiter.api.Test;

class OfferTest {
    @Test
    void separatesOffers() {}
}
'''

        updated = allure_ids.render_change(
            content,
            Path("OfferTest.java"),
            "separatesOffers",
            "99",
            None,
        )

        self.assertIn("import io.qameta.allure.AllureId;\n", updated)
        self.assertIn('@Test\n    @AllureId("99")\n', updated)

    def test_is_idempotent_for_same_id(self):
        content = '''import io.qameta.allure.AllureId
import org.junit.jupiter.api.Test

class OfferTest {
    @Test
    @AllureId("42")
    fun result() = Unit
}
'''

        updated = allure_ids.render_change(content, Path("OfferTest.kt"), "result", "42", None)

        self.assertEqual(content, updated)

    def test_rejects_different_existing_id(self):
        content = '''class OfferTest {
    @Test
    @AllureId("42")
    fun result() = Unit
}
'''

        with self.assertRaisesRegex(ValueError, "уже есть"):
            allure_ids.render_change(content, Path("OfferTest.kt"), "result", "43", None)

    def test_rejects_stale_line(self):
        content = '''class OfferTest {
    @Test
    fun result() = Unit
}
'''

        with self.assertRaisesRegex(ValueError, "могли измениться"):
            allure_ids.render_change(content, Path("OfferTest.kt"), "result", "42", 99)

    def test_atomic_write_leaves_no_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "OfferTest.kt"
            path.write_text("before", encoding="utf-8")

            allure_ids._atomic_write(path, "after")

            self.assertEqual("after", path.read_text(encoding="utf-8"))
            self.assertEqual([path], list(Path(directory).iterdir()))

    def test_preserves_crlf(self):
        content = "class OfferTest {\r\n    @Test\r\n    fun result() = Unit\r\n}\r\n"

        updated = allure_ids.render_change(content, Path("OfferTest.kt"), "result", "42", None)

        self.assertNotIn("\n", updated.replace("\r\n", ""))
        self.assertIn('@Test\r\n    @AllureId("42")\r\n', updated)


class CliTests(unittest.TestCase):
    def test_scan_check_apply_and_rescan(self):
        content = '''package ru.test

import org.junit.jupiter.api.Test

class OfferTest {
    @Test
    fun `separates offers`() = Unit
}
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "OfferTest.kt"
            path.write_text(content, encoding="utf-8")

            scan = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "scan", "--file", str(path), "--format", "json"],
                check=True,
                capture_output=True,
                text=True,
            )
            test = json.loads(scan.stdout)["tests"][0]
            command = [
                sys.executable,
                str(SCRIPT_PATH),
                "apply",
                "--file",
                str(path),
                "--method",
                test["methodName"],
                "--line",
                str(test["testLine"]),
                "--id",
                "8068313",
            ]

            check = subprocess.run(command + ["--check"], check=True, capture_output=True, text=True)

            self.assertIn('+    @AllureId("8068313")', check.stdout)
            self.assertEqual(content, path.read_text(encoding="utf-8"))

            subprocess.run(command, check=True, capture_output=True, text=True)
            rescan = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "scan", "--file", str(path), "--format", "json"],
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertEqual([], json.loads(rescan.stdout)["tests"])
            self.assertEqual([path], list(Path(directory).iterdir()))


if __name__ == "__main__":
    unittest.main()
