import argparse
import json
import re
import urllib.request

import fitz


CHINESE_YEARS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def clean_page(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and ("募集说明书" in lines[0] or "发行公告" in lines[0]):
        lines.pop(0)
    if lines and re.fullmatch(r"\d{1,4}", lines[0]):
        lines.pop(0)
    return "\n".join(lines)


def coupon_rates(text):
    compact = re.sub(r"\s+", "", text)
    found = {}
    for year, rate in re.findall(r"第([一二三四五六七八九十\d]+)年(?:票面利率)?为?(\d+(?:\.\d+)?)%", compact):
        number = int(year) if year.isdigit() else CHINESE_YEARS.get(year)
        if number:
            found[number] = float(rate)
    return [{"interest_year": year, "coupon_rate": found[year]} for year in sorted(found)]


def concise_projects(section):
    lines = [line.strip() for line in section.splitlines() if line.strip()]
    headings = []
    for line in lines:
        match = re.match(r"^[一二三四五六七八九十]+[、.．]\s*(.+)$", line)
        if match:
            name = re.sub(r"\s+\d+(?:\.\d+)?$", "", match.group(1)).strip()
            if name and not name.startswith("募集资金"):
                headings.append(name)
    if len(headings) >= 2:
        names = headings
    else:
        names = []
        start = next((i + 1 for i, line in enumerate(lines) if line in {"拟投入募集资金", "拟使用募集资金"}), 0)
        index = start
        while index < len(lines):
            line = lines[index]
            inline = re.match(r"^(\d{1,2})[、.．]\s*(.+)$", line)
            rank = re.fullmatch(r"\d{1,2}", line)
            if inline:
                name = inline.group(2).strip()
                index += 1
            elif rank:
                parts = []
                index += 1
                while index < len(lines):
                    current = lines[index]
                    if re.fullmatch(r"\d[\d,]*(?:\.\d+)?", current) or re.fullmatch(r"\d+(?:\.\d+)?%", current):
                        break
                    if re.fullmatch(r"\d{1,2}", current) or re.match(r"^\d{1,2}[、.．]", current):
                        break
                    if current not in {"项目名称", "序号", "小计", "合计"}:
                        parts.append(current)
                    index += 1
                name = "".join(parts).strip()
            else:
                index += 1
                continue
            name = re.sub(r"\s+\d+(?:\.\d+)?$", "", name).strip()
            if name and not re.fullmatch(r"\d+(?:\.\d+)?", name) and len(name) >= 4 and not re.search(r"总投资|募集资金|单位[:：]|合计|小计|备案证明", name):
                names.append(name)
                if re.search(r"补充(?:流动|营运)资金|偿还银行贷款", name):
                    break
        if not names and headings:
            names = headings
    unique = []
    for name in names:
        if name not in unique:
            unique.append(name)
    return "\n".join(f"{index}.{name}" for index, name in enumerate(unique, 1)) or None


def fundraising_purpose(pages):
    candidates = []
    for index, page in enumerate(pages):
        keys = [key for key in ("本次募集资金用途", "本次募集资金投资项目概况", "本次募集资金运用") if key in page]
        if not keys:
            continue
        combined = "\n".join(pages[index:index + 3])
        score = 5 * combined.count("拟投入募集资金") + 3 * combined.count("项目名称") + combined.count("单位：万元")
        score += len(re.findall(r"(?m)^\s*\d[\d,]*\.\d{2}\s*$", combined))
        if "目录" in page[:200]:
            score -= 20
        candidates.append((score, combined, keys))
    for _, combined, keys in sorted(candidates, key=lambda item: item[0], reverse=True):
        key = next((value for value in ("本次募集资金投资项目概况", "本次募集资金用途", "本次募集资金运用") if value in keys), keys[0])
        start = combined.find(key)
        section = combined[start + len(key):]
        project_stop = re.search(r"(?m)^\s*[二三四五六七八九十]+[、.．]\s*本次募集资金投资项目基本情况", section)
        if project_stop:
            section = section[:project_stop.start()]
        stop = re.search(r"(?m)^\s*\d{1,2}[、.．]\s*募集资金(?:存放|专项存储)", section)
        if stop:
            section = section[:stop.start()]
        result = concise_projects(section)
        if result and not re.search(r"担保事项|评级事项|受托管理", result):
            return result
    return None


def extract(url):
    if not url.startswith("https://static.cninfo.com.cn/"):
        raise ValueError("仅允许读取巨潮资讯官方 PDF")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(30 * 1024 * 1024 + 1)
    if len(data) > 30 * 1024 * 1024:
        raise ValueError("PDF 文件超过 30MB")
    document = fitz.open(stream=data, filetype="pdf")
    pages = [clean_page(page.get_text()) for page in document]
    rates = []
    for page in pages:
        if "债券利率" in page or "票面利率" in page:
            rates = coupon_rates(page)
            if rates:
                break
    return {"fundraising_purpose": fundraising_purpose(pages), "coupon_rates": rates}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    args = parser.parse_args()
    print(json.dumps(extract(args.url), ensure_ascii=False))


if __name__ == "__main__":
    main()
