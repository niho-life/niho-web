-- 鎌倉サイトの表示名から「（新サイト確認用）」を外す（新サイトは本番に切り替わったため）。
UPDATE sites
   SET name = '鎌倉サイト'
 WHERE id = 'kamakura'
   AND project_id = 'project-kamakura';
