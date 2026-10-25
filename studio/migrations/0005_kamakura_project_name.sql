-- 鎌倉の Project の表示名を正す（0001 の seed の表示の誤り・niho-life/kamakura-site#108）。
UPDATE projects
   SET name = 'NIHO kamakura'
 WHERE id = 'project-kamakura';
