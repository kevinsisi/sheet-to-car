ALTER TABLE team_members ADD COLUMN aliases TEXT NOT NULL DEFAULT '';

UPDATE team_members
SET aliases = CASE english_name
  WHEN 'James' THEN '謝,訂車謝,JJ,訂車JJ'
  WHEN '小郭' THEN '郭,訂車郭'
  WHEN 'Hank' THEN '信翰,訂車信,林'
  WHEN 'Roger' THEN '李'
  WHEN 'Mita' THEN '劉'
  ELSE aliases
END
WHERE aliases = '' OR aliases IS NULL;
