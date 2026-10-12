import argparse
import json
import re
import urllib.request
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'ipo-report'))
from external_call_guard import guarded_urlopen

import fitz
from convertibleBondDocument import read_document


def extract_rating(url, announcement_date=None, security_code=None, bond_name=None, issuer_name=None):
    pages, evidence = read_document(url, security_code, bond_name, issuer_name)
    text = "\n".join(pages)
    compact = re.sub(r"\s+", "", text)
    outlook_match = re.search(r"评级展望\s*(?:调整)?为?\s*[：:]?\s*(稳定|正面|负面|发展中|观察)", text)
    rating_match = re.search(
        r"主体信用等级由[A-D]{1,3}[+-]?(?:调整至|调降至|上调至)[“\"]?([A-D]{1,3}[+-]?)",
        compact,
    )
    if not rating_match:
        rating_match = re.search(r"主体(?:长期)?信用等级\s*(?:为)?\s*[：:]?\s*([A-D]{1,3}[+-]?)", text)
    if not rating_match:
        rating_match = re.search(r"主体信用等级为[“\"]?([A-D]{1,3}[+-]?)", compact)
    if bond_name:
        rating_match = re.search(re.escape(bond_name) + r"[”\"]?(?:的)?(?:债项)?信用等级(?:均为|为|维持为|：|:)?[“\"]?([A-D]{1,3}[+-]?)", compact)
    date_match = re.search(r"评级日期[：:]?(20\d{2})年(\d{1,2})月(\d{1,2})日", compact)
    rating_date = announcement_date
    rating_date_source = 'announcement_fallback'
    if date_match:
        rating_date = f"{int(date_match.group(1)):04d}-{int(date_match.group(2)):02d}-{int(date_match.group(3)):02d}"
        rating_date_source = 'official_document'
    else:
        table_date = re.search(r"本次评级时间.{0,120}?(20\d{2})/(\d{1,2})/(\d{1,2})", compact)
        if table_date:
            rating_date = f"{int(table_date.group(1)):04d}-{int(table_date.group(2)):02d}-{int(table_date.group(3)):02d}"
            rating_date_source = 'official_document'
    return {
        **evidence,
        "rating_date": rating_date,
        "rating_date_source": rating_date_source,
        "rating": rating_match.group(1) if rating_match else None,
        "rating_outlook": outlook_match.group(1) if outlook_match else None,
        "source_url": url,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--announcement-date", default=None)
    parser.add_argument("--security-code", default=None)
    parser.add_argument("--bond-name", default=None)
    parser.add_argument("--issuer-name", default=None)
    args = parser.parse_args()
    print(json.dumps(extract_rating(args.url, args.announcement_date, args.security_code, args.bond_name, args.issuer_name), ensure_ascii=False))


if __name__ == "__main__":
    main()
