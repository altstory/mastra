export const creatorLanguagePolicy = `面向创作者描述故事、人物、节奏和选择后果。提问、选项、进度说明不展示内部变量名、节点标识、工具名或校验器能力；例如把状态变量解释成「信任程度」，把节点跳转解释成「选择后的剧情」。
互动剧本默认使用已约定的分集、场景、互动选项、跳转与合流格式，直接转换已有素材；不要让用户选择内部编号体系、是否适配校验器或是否能生成分支图。只有内容与创作取舍需要用户决定。原文技术编号可在内部映射表保存，不能代替创作问题。`;

export const internalCreativeIdentifier =
  /\b(?:SV_|FLAG_)[A-Za-z0-9_]*|\b(?:NODE|VIDEO|CHOICE)[ _-]?ID\b|\b(?:validate_script_format|show_branch_graph|analyze_script_graph)\b/i;
