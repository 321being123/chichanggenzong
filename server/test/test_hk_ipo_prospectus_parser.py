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


if __name__ == "__main__":
    test_maximum_price_is_not_final_price()
    test_price_range_and_chinese_maximum()
    test_missing_expected_dates_stay_empty()
    print("PASS=3  FAIL=0  ERROR=0")
