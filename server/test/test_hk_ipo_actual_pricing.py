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
    hdr_text = 'Final Offer Price HK$26.60. No. of Offer HDRs initially available under the Hong Kong Public Offering 8,966,900. No. of Offer HDRs initially available under the International Offering 80,701,700.'
    hdr_result = parse_allotment_text(hdr_text)
    assert hdr_result['parserStatus'] == 'parsed'
    assert hdr_result['actualPricingDateStatus'] == 'not_disclosed'
    for label, public, international in [('excluding', '1,136,900', '10,232,000'), ('excluded', '7,501,400', '67,511,900')]:
        # 01377、02476官方配发公告的原表述；不把扣除员工后的股数冒充整体比例。
        text = f'Final Offer Price HK$380.00. No. of Offer Shares {label} Overseas Employee Reserved Shares initially available under the Hong Kong Public Offering {public}. No. of Offer Shares initially available under the International Offering (excluding the PRC Employee Reserved Shares under the PRC Employee Preferential Offering) {international}.'
        result = parse_allotment_text(text)
        assert result['actualPricingDateStatus'] == 'not_disclosed'
        assert result['actualPricingDate'] is None
        assert result['parserStatus'] == 'incomplete'
        assert parse_allotment_text(text + ' Offer Price was determined on 31 September 2026.')['actualPricingDateStatus'] == 'unresolved'
    text = 'Stock Code: 2523. The Company has decided that the Global Offering and the Listing will not proceed at this time. Hong Kong, Wednesday, 8 July 2026'
    assert parse_listing_status_notice(text)['stockCode'] == '02523'
    assert parse_allotment_text(text)['listingStatusNotice']['announcedAt'] == '2026-07-08'
    assert parse_listing_status_notice(text.replace('has decided', 'may decide')) is None
    assert parse_listing_status_notice(text.replace('8 July', '32 July')) is None
    assert parse_listing_status_notice(text.replace('Stock Code: 2523.', '')) is None
    print('PASS=2 FAIL=0 ERROR=0')
