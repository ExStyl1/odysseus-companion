#!/usr/bin/env python3

import argparse
import difflib
import json
import os
import re
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path


ALLURE_IMPORT = "import io.qameta.allure.AllureId"
TEST_ANNOTATION_RE = re.compile(r"^@(?:[\w$]+\.)*Test\b")
TEST_FACTORY_RE = re.compile(r"^@(?:[\w$]+\.)*TestFactory\b")
ALLURE_ID_RE = re.compile(r'@(?:[\w$]+\.)*AllureId\s*\(\s*["\']?(\d+)["\']?\s*\)')
DISPLAY_NAME_RE = re.compile(
    r'@(?:[\w$]+\.)*DisplayName\s*\(\s*("(?:\\.|[^"\\])*")',
    re.DOTALL,
)
CLASS_RE = re.compile(r"\b(?:class|interface|object|record)\s+([A-Za-z_$][\w$]*)")
KOTLIN_METHOD_RE = re.compile(r"\bfun\s+(`[^`]+`|[A-Za-z_$][\w$]*)\s*\(")
JAVA_METHOD_RE = re.compile(r"\b([A-Za-z_$][\w$]*)\s*\(")
JAVA_NON_METHODS = {"if", "for", "while", "switch", "catch", "new", "return", "throw"}


@dataclass(frozen=True)
class TestCase:
    file: str
    language: str
    packageName: str | None
    className: str | None
    methodName: str
    displayName: str | None
    name: str
    fullName: str
    testLine: int
    methodLine: int
    allureId: str | None


def _annotation_name_matches(annotation: str, pattern: re.Pattern[str]) -> bool:
    return pattern.search(annotation.lstrip()) is not None


def _method_name(line: str, language: str) -> str | None:
    if language == "kotlin":
        match = KOTLIN_METHOD_RE.search(line)
        if not match:
            return None
        return match.group(1).strip("`")

    candidates = [match.group(1) for match in JAVA_METHOD_RE.finditer(line)]
    return next((candidate for candidate in reversed(candidates) if candidate not in JAVA_NON_METHODS), None)


def _display_name(annotations: list[tuple[int, str]]) -> str | None:
    joined = "\n".join(annotation for _, annotation in annotations)
    match = DISPLAY_NAME_RE.search(joined)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return match.group(1)[1:-1]


def _package_name(content: str) -> str | None:
    match = re.search(r"^\s*package\s+([\w.]+)\s*;?", content, re.MULTILINE)
    return match.group(1) if match else None


def _parenthesis_depth(text: str) -> int:
    depth = 0
    quote = None
    escaped = False
    for character in text:
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote:
            escaped = True
            continue
        if character in {'"', "'"}:
            quote = None if quote == character else character if quote is None else quote
            continue
        if quote is None:
            if character == "(":
                depth += 1
            elif character == ")":
                depth -= 1
    return depth


def scan_content(content: str, path: Path) -> list[TestCase]:
    if path.suffix not in {".kt", ".java"}:
        raise ValueError(f"Поддерживаются только .kt и .java: {path}")
    language = "kotlin" if path.suffix == ".kt" else "java"
    package_name = _package_name(content)
    current_class = None
    annotations: list[tuple[int, str]] = []
    annotation_depth = 0
    results: list[TestCase] = []

    for index, raw_line in enumerate(content.splitlines()):
        stripped = raw_line.strip()

        if annotation_depth > 0 and annotations:
            start, text = annotations[-1]
            text = f"{text}\n{stripped}"
            annotations[-1] = (start, text)
            annotation_depth = _parenthesis_depth(text)
            continue

        if stripped.startswith("@"):
            annotations.append((index, stripped))
            annotation_depth = max(0, _parenthesis_depth(stripped))
            continue

        class_match = CLASS_RE.search(stripped)
        if class_match:
            current_class = class_match.group(1)

        method_name = _method_name(stripped, language)
        if method_name and annotations:
            test_annotations = [
                item for item in annotations if _annotation_name_matches(item[1], TEST_ANNOTATION_RE)
            ]
            is_factory = any(
                _annotation_name_matches(annotation, TEST_FACTORY_RE)
                for _, annotation in annotations
            )
            if test_annotations and not is_factory:
                allure_id = None
                for _, annotation in annotations:
                    allure_match = ALLURE_ID_RE.search(annotation)
                    if allure_match:
                        allure_id = allure_match.group(1)
                        break

                display_name = _display_name(annotations)
                parts = [part for part in (package_name, current_class, method_name) if part]
                results.append(
                    TestCase(
                        file=str(path),
                        language=language,
                        packageName=package_name,
                        className=current_class,
                        methodName=method_name,
                        displayName=display_name,
                        name=display_name or method_name,
                        fullName=".".join(parts),
                        testLine=test_annotations[0][0] + 1,
                        methodLine=index + 1,
                        allureId=allure_id,
                    )
                )

            annotations = []
            continue

        if not stripped or stripped.startswith(("//", "/*", "*", "*/")):
            continue

        if annotations:
            annotations = []

    return results


def scan_path(path: Path) -> list[TestCase]:
    if path.is_file():
        if path.suffix not in {".kt", ".java"}:
            raise ValueError(f"Поддерживаются только .kt и .java: {path}")
        paths = [path]
    else:
        paths = sorted(
            candidate
            for suffix in ("*.kt", "*.java")
            for candidate in path.rglob(suffix)
        )

    tests: list[TestCase] = []
    for candidate in paths:
        content = _read_source(candidate)
        if "@Test" in content:
            tests.extend(scan_content(content, candidate))
    return tests


def _read_source(path: Path) -> str:
    with path.open(mode="r", encoding="utf-8", newline="") as source:
        return source.read()


def _has_allure_import(content: str) -> bool:
    return re.search(
        r"^\s*import\s+io\.qameta\.allure\.(?:AllureId|\*)\s*;?\s*$",
        content,
        re.MULTILINE,
    ) is not None


def _ensure_import(content: str, language: str) -> str:
    if _has_allure_import(content):
        return content

    newline = "\r\n" if "\r\n" in content else "\n"
    import_line = ALLURE_IMPORT + (";" if language == "java" else "") + newline
    lines = content.splitlines(keepends=True)
    import_indexes = [index for index, line in enumerate(lines) if line.strip().startswith("import ")]

    if import_indexes:
        import_key = import_line.strip().removesuffix(";")
        insert_at = import_indexes[-1] + 1
        for index in import_indexes:
            existing_key = lines[index].strip().removesuffix(";")
            if existing_key > import_key:
                insert_at = index
                break
        lines.insert(insert_at, import_line)
        return "".join(lines)

    package_indexes = [index for index, line in enumerate(lines) if line.strip().startswith("package ")]
    if package_indexes:
        insert_at = package_indexes[0] + 1
        while insert_at < len(lines) and not lines[insert_at].strip():
            insert_at += 1
        lines.insert(insert_at, import_line + newline)
        return "".join(lines)

    return import_line + newline + content


def render_change(content: str, path: Path, method_name: str, allure_id: str, line: int | None) -> str:
    if not re.fullmatch(r"[1-9]\d*", allure_id):
        raise ValueError("Allure ID должен быть положительным целым числом")

    candidates = [test for test in scan_content(content, path) if test.methodName == method_name]
    if line is not None:
        candidates = [test for test in candidates if test.testLine == line or test.methodLine == line]

    if not candidates:
        raise ValueError(
            "Тест не найден; файл или строка могли измениться после scan"
        )
    if len(candidates) > 1:
        raise ValueError(
            "Найдено несколько тестов; укажите --line из результата scan"
        )

    target = candidates[0]
    if target.allureId:
        if target.allureId == allure_id:
            return content
        raise ValueError(f'У теста уже есть @AllureId("{target.allureId}")')

    lines = content.splitlines(keepends=True)
    annotation_index = target.testLine - 1
    raw_test_line = lines[annotation_index]
    indentation = re.match(r"^\s*", raw_test_line).group(0)
    newline = "\r\n" if raw_test_line.endswith("\r\n") else "\n"
    lines.insert(annotation_index + 1, f'{indentation}@AllureId("{allure_id}"){newline}')
    return _ensure_import("".join(lines), target.language)


def _atomic_write(path: Path, content: str) -> None:
    mode = path.stat().st_mode
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temp_name = temporary.name
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def _print_scan(tests: list[TestCase], output_format: str) -> None:
    if output_format == "json":
        print(json.dumps({"tests": [asdict(test) for test in tests]}, ensure_ascii=False, indent=2))
        return

    if not tests:
        print("Тесты без @AllureId не найдены")
        return
    for test in tests:
        print(f"{test.file}:{test.testLine}\t{test.name}\t{test.fullName}")


def _run_scan(args: argparse.Namespace) -> int:
    path = Path(args.file or args.dir)
    if not path.exists():
        raise ValueError(f"Путь не найден: {path}")
    tests = scan_path(path)
    if not args.include_existing:
        tests = [test for test in tests if test.allureId is None]
    _print_scan(tests, args.format)
    return 0


def _run_apply(args: argparse.Namespace) -> int:
    path = Path(args.file)
    content = _read_source(path)
    updated = render_change(content, path, args.method, args.id, args.line)
    if updated == content:
        print(f'{path}: @AllureId("{args.id}") уже установлен')
        return 0

    if args.check:
        print(
            "".join(
                difflib.unified_diff(
                    content.splitlines(keepends=True),
                    updated.splitlines(keepends=True),
                    fromfile=str(path),
                    tofile=str(path),
                )
            ),
            end="",
        )
        return 0

    _atomic_write(path, updated)
    print(f'{path}: добавлен @AllureId("{args.id}") для {args.method}')
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Детерминированная обработка @AllureId в Kotlin/Java"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser("scan", help="Найти тесты без @AllureId")
    target = scan_parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--file")
    target.add_argument("--dir")
    scan_parser.add_argument("--include-existing", action="store_true")
    scan_parser.add_argument("--format", choices=("human", "json"), default="human")
    scan_parser.set_defaults(handler=_run_scan)

    apply_parser = subparsers.add_parser("apply", help="Добавить один проверенный Allure ID")
    apply_parser.add_argument("--file", required=True)
    apply_parser.add_argument("--method", required=True)
    apply_parser.add_argument("--id", required=True)
    apply_parser.add_argument("--line", type=int)
    apply_parser.add_argument("--check", action="store_true", help="Показать diff без записи")
    apply_parser.set_defaults(handler=_run_apply)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.handler(args)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
