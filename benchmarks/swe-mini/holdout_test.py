import unittest
from holdout import select_tasks, QUOTAS


class SelectionTests(unittest.TestCase):
    def test_fixed_balanced_disjoint_and_order_independent(self):
        rows = []
        for repo, count in QUOTAS.items():
            for i in range(count + 3):
                rows.append(dict(instance_id=repo.replace('/', '__') + '-' + str(i), repo=repo,
                                 problem_statement=repo + ' unique problem ' + str(i)))
        source = [rows[0]]
        selected = select_tasks(rows, source)
        self.assertEqual(len(selected), 40)
        self.assertNotIn(source[0]['instance_id'], [r['instance_id'] for r in selected])
        self.assertEqual(selected, select_tasks(list(reversed(rows)), source))
        for repo, count in QUOTAS.items():
            self.assertEqual(sum(r['repo'] == repo for r in selected), count)

    def test_insufficient_or_duplicate_problems_fail(self):
        with self.assertRaises(ValueError):
            select_tasks([], [])
        rows = [dict(instance_id=str(i), repo='django/django', problem_statement=' Same  Issue ') for i in range(60)]
        with self.assertRaises(ValueError):
            select_tasks(rows, [dict(instance_id='other', problem_statement='same issue')])


if __name__ == '__main__':
    unittest.main()
