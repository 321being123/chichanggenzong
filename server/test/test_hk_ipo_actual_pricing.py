import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from extractHkIpoAllotment import parse_allotment_text, parse_listing_status_notice


def test_actual_price_date_requires_explicit_past_event():
    result = parse_allotment_text('The Offer Price was determined on 24 September 2026. Final Offer Price HK$8.50.')
    assert result['actualPricingDate'] == '2026-09-24'
    assert result['evidence']['actualPricingDate'] == 'Offer Price was determined on 24 September 2026'
    assert result['finalOfferPrice'] == 8.5
    for text in ['The Offer Price is expected to be determined on 24 September 2026.',
                 'Announcement published on 24 September 2026. Final Offer Price HK$8.50.',
                 'The Offer Price was determined on 31 September 2026.']:
        assert parse_allotment_text(text)['actualPricingDate'] is None


def test_actual_pricing_date_variants():
    for text in ['Final Offer Price was fixed on 24 September 2026.', 'Offer Price has been agreed on September 24, 2026.', '最終發售價已於2026年9月24日釐定。']:
        assert parse_allotment_text(text)['actualPricingDate'] == '2026-09-24'
    assert parse_allotment_text('預期最終發售價於2026年9月24日釐定。')['actualPricingDate'] is None
    assert parse_allotment_text('The Offer Price was determined on 31 September 2026.')['actualPricingDateStatus'] == 'unresolved'
    assert parse_allotment_text('Offer Price was fixed on 24 September 2026. Offer Price was fixed on 25 September 2026.')['actualPricingDate'] is None


if __name__ == '__main__':
    test_actual_price_date_requires_explicit_past_event()
    test_actual_pricing_date_variants()
    text = 'Stock Code: 2523. The Company has decided that the Global Offering and the Listing will not proceed at this time. Hong Kong, Wednesday, 8 July 2026'
    assert parse_listing_status_notice(text)['stockCode'] == '02523'
    assert parse_allotment_text(text)['listingStatusNotice']['announcedAt'] == '2026-07-08'
    assert parse_listing_status_notice(text.replace('has decided', 'may decide')) is None
    assert parse_listing_status_notice(text.replace('8 July', '32 July')) is None
    assert parse_listing_status_notice(text.replace('Stock Code: 2523.', '')) is None
    print('PASS=2 FAIL=0 ERROR=0')
