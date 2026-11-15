// 只在用户真正碰表单、页面转后台或稳定空闲后装载的重能力。
// 顺序有意把最轻的正文采集放在前面：即使一次空闲窗口装不完，索引也已经能开始工作。

import './page-text/index.js'
import './address-autofill/index.js'
import './password-autofill/index.js'
