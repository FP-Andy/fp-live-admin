"""CSV versions must preserve review time, decision and assigned referees."""
import csv
import io
import unittest

from case_intake import parse_csv


class ReviewCsvTests(unittest.TestCase):
    def csv(self, duration_columns, values):
        fields=['경기번호','경기일','홈팀','원정팀','심판1','심판2','심판3',
                '판독횟수','쿼터','경기시간',*duration_columns,'판독구분',
                '판독결과','판독결과(직접입력)','요청팀','작성자','기록시각']
        row={'경기번호':'999','경기일':'2026-11-13','홈팀':'테스트 홈','원정팀':'테스트 원정',
             '심판1':'10.이승환','심판2':'37.한정원','심판3':'30.김수연',
             '판독횟수':'1','쿼터':'1Q','경기시간':'4:41','판독구분':'감독 요청',
             '판독결과':'유지','판독결과(직접입력)':'파울 선언','요청팀':'테스트 홈',
             '작성자':'테스트','기록시각':'기록 시각'}
        row.update(dict(zip(duration_columns,values)))
        out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields)
        writer.writeheader();writer.writerow(row)
        return out.getvalue().encode('utf-8-sig')

    def test_new_and_old_headers_keep_review_and_referees(self):
        cases=[parse_csv(self.csv([header],['17'])) for header in ('판독소요시간(초)','소요시간(초)')]
        for case in cases:
            event=case['events'][0]
            self.assertEqual((event['reviewDurationSeconds'],event['quarter'],event['gameClock']), (17,1,'4:41'))
            self.assertEqual((event['recordedDecision'],event['recordedReason']),('유지','파울 선언'))
            self.assertEqual([r['number'] for r in case['referees']],[10,37,30])

    def test_both_headers_must_agree(self):
        headers=['판독소요시간(초)','소요시간(초)']
        self.assertEqual(parse_csv(self.csv(headers,['17','17']))['events'][0]['reviewDurationSeconds'],17)
        self.assertEqual(parse_csv(self.csv(headers,['17','']))['events'][0]['reviewDurationSeconds'],17)
        with self.assertRaisesRegex(ValueError,'두 소요시간 열의 값이 다릅니다'):
            parse_csv(self.csv(headers,['17','18']))

    def test_missing_or_invalid_duration_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'판독소요시간'):
            parse_csv(self.csv([],[]))
        for value in ('','-1','잘못된 값'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError,'판독 소요시간'):
                parse_csv(self.csv(['판독소요시간(초)'],[value]))


if __name__=='__main__':unittest.main()
