SELECT
    *
FROM
    `your-bigquery-project.was_there_extreme_weather`
    LEFT OUTER JOIN `your-bigquery-project.repositories_that_mention_extreme_weather` USING (date)
ORDER BY
    date
