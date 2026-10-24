# Do the links in docs/*.md still point at files that exist? Is the numbering of PROBLEMS.md intact?
#   python -m app.measure.check_docs      (or: make check-docs)
# Run it after moving or renaming files. Prints every broken link and exits with 1 if there is one.
import os
import re
import sys

broken = 0
for doc in ("docs/PROJECT.md", "docs/PROBLEMS.md"):
    text = open(doc).read()
    # Examples inside code blocks and `code spans` are text, not links, so leave them out.
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`\n]*`", "", text)
    for target in re.findall(r"\]\(([^)#\s]+)(?:#[^)]*)?\)", text):
        if target.startswith(("http", "mailto")):
            continue
        if not os.path.exists(os.path.normpath(os.path.join("docs", target))):
            print(f"broken link in {doc}: {target}")
            broken += 1

numbers = [int(n) for n in re.findall(r"^## (\d+)\. ", open("docs/PROBLEMS.md").read(), flags=re.M)]
if numbers != list(range(1, len(numbers) + 1)):
    print("PROBLEMS.md entry numbers are not 1, 2, 3, ... in order:", numbers)
    broken += 1

print("docs ok" if broken == 0 else f"{broken} problem(s) found")
sys.exit(1 if broken else 0)
