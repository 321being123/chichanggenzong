import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from extractHkIpoProspectus import parse_prospectus_text


def test_maximum_price_is_not_final_price():
    result = parse_prospectus_text(
        "Maximum Offer Price HK$88.00. Board lot size of 100 shares. "
        "Hong Kong Public Offering commences on 18 September 2026 at 9:00 a.m. "
        "Latest time for lodging applications is 12:00 noon on 23 September 2026. "
        "The price is expected to be fixed on 24 September 2026. "
        "Announcement of allotment results is expected to be published on 29 September 2026. "
        "Listing on the main board of the stock exchange is expected to take place on 30 September 2026."
    )
    assert result["issuePriceLow"] is None
    assert result["issuePriceHigh"] == 88.0
    assert result["issuePriceType"] == "maximum_only"
    assert result["parserStatus"] == "parsed"
    assert result["expectedPricingDate"] == "2026-09-24"
    assert result["expectedAllotmentDate"] == "2026-09-29"
    assert result["expectedListingDate"] == "2026-09-30"


def test_price_range_and_chinese_maximum():
    ranged = parse_prospectus_text("Offer Price HK$8.50–HK$10.00")
    assert ranged["issuePriceLow"] == 8.5
    assert ranged["issuePriceHigh"] == 10.0
    assert ranged["issuePriceType"] == "range"

    maximum = parse_prospectus_text("最高發售價：港元 16.80")
    assert maximum["issuePriceLow"] is None
    assert maximum["issuePriceHigh"] == 16.8
    assert maximum["issuePriceType"] == "maximum_only"


def test_missing_expected_dates_stay_empty():
    result = parse_prospectus_text("Board lot size of 100 shares")
    assert result["expectedPricingDate"] is None
    assert result["expectedAllotmentDate"] is None
    assert result["expectedListingDate"] is None


def test_chinese_expected_timetable():
    result = parse_prospectus_text(
        "公佈香港公開發售分配結果（包括獲接納申請人的身份證明文件號碼），包括："
        "分別於本公司網站及聯交所網站發佈公告 . . . 不遲於2026年10月8日（星期四） 下午十一時正 "
        "H股開始在聯交所買賣 . . . 2026年10月9日（星期五） 上午九時正"
    )
    assert result["expectedAllotmentDate"] == "2026-10-08"
    assert result["expectedListingDate"] == "2026-10-09"
    assert result.get("allotmentAt") is None
    assert result.get("listingAt") is None


def test_english_month_first_timetable_and_prose_bounds():
    result = parse_prospectus_text(
        "The Offer Price will not be more than HK$38.80 per Offer Share and is currently expected to be not less than HK$35.30 per Offer Share. "
        "Minimum of 100 Hong Kong Offer Shares. "
        "Hong Kong Public Offering commences . . .9:00 a.m. on Wednesday, October 7, 2026 "
        "Application lists close(3) . . .12:00 noon on Monday, October 12, 2026 "
        "Expected Price Determination Date . . .by 12:00 noon on Tuesday, October 13, 2026 "
        "Announcement of the Offer Price, the level of indications of interest in the International Offering, "
        "the level of applications in the Hong Kong Public Offering and the basis of allocations of the Hong Kong Offer Shares "
        "to be published on the website of the Stock Exchange . . .Wednesday, October 14, 2026 "
        "Dealings in the H Shares on the Stock Exchange expected to commence at . . .9:00 a.m. on Thursday, October 15, 2026"
    )
    assert result["issuePriceLow"] == 35.30
    assert result["issuePriceHigh"] == 38.80
    assert result["issuePriceType"] == "range"
    assert result["offerOpenAt"] == "2026-10-07T09:00:00+08:00"
    assert result["offerCloseAt"] == "2026-10-12T12:00:00+08:00"
    assert result["expectedPricingDate"] == "2026-10-13"
    assert result["expectedAllotmentDate"] == "2026-10-14"
    assert result["expectedListingDate"] == "2026-10-15"
    assert result.get("issuePriceFinal") is None
    assert result.get("listingAt") is None


def test_invalid_month_first_date_does_not_publish():
    result = parse_prospectus_text("Hong Kong Public Offering commences 9:00 a.m. on October 32, 2026")
    assert result["offerOpenAt"] is None


if __name__ == "__main__":
    test_maximum_price_is_not_final_price()
    test_price_range_and_chinese_maximum()
    test_missing_expected_dates_stay_empty()
    test_chinese_expected_timetable()
    test_english_month_first_timetable_and_prose_bounds()
    test_invalid_month_first_date_does_not_publish()
    print("PASS=6  FAIL=0  ERROR=0")
