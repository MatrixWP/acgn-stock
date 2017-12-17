import { _ } from 'meteor/underscore';
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';

import { dbCompanyArchive } from '/db/dbCompanyArchive';
import { dbFoundations } from '/db/dbFoundations';
import { dbLog } from '/db/dbLog';
import { limitMethod } from '/server/imports/utils/rateLimit';
import { debug } from '/server/imports/utils/debug';
import { resourceManager } from '/server/imports/threading/resourceManager';

Meteor.methods({
  investArchiveCompany(companyId) {
    check(this.userId, String);
    check(companyId, String);
    investArchiveCompany(Meteor.user(), companyId);

    return true;
  }
});
export function investArchiveCompany(user, companyId) {
  debug.log('investArchiveCompany', {user, companyId});
  if (user.profile.isInVacation) {
    throw new Meteor.Error(403, '您現在正在渡假中，請好好放鬆！');
  }
  if (user.profile.notPayTax) {
    throw new Meteor.Error(403, '您現在有稅單逾期未繳！');
  }
  if (_.contains(user.profile.ban, 'deal')) {
    throw new Meteor.Error(403, '您現在被金融管理會禁止了所有投資下單行為！');
  }
  const amount = Meteor.settings.public.founderEarnestMoney;
  if (user.profile.money < amount) {
    throw new Meteor.Error(403, '金錢不足，無法投資！');
  }
  const archiveCompanyData = dbCompanyArchive.findOne(companyId, {
    fields: {
      status: 1,
      invest: 1
    }
  });
  if (! archiveCompanyData || archiveCompanyData.status !== 'archived') {
    throw new Meteor.Error(404, '保管庫公司並不存在，可能已經上市或被移除！');
  }
  const userId = user._id;
  if (_.contains(archiveCompanyData.invest, userId)) {
    throw new Meteor.Error(403, '您已經投資過此保管庫公司了！');
  }
  //先鎖定資源，再重新讀取一次資料進行運算
  resourceManager.throwErrorIsResourceIsLock(['archive' + companyId, 'user' + userId]);
  resourceManager.request('investArchiveCompany', ['archive' + companyId, 'user' + userId], (release) => {
    const user = Meteor.users.findOne(userId, {
      fields: {
        profile: 1
      }
    });
    if (user.profile.money < amount) {
      throw new Meteor.Error(403, '金錢不足，無法投資！');
    }
    const archiveCompanyData = dbCompanyArchive.findOne(companyId);
    if (! archiveCompanyData || archiveCompanyData.status !== 'archived') {
      throw new Meteor.Error(404, '保管庫公司並不存在，可能已經上市或被移除！');
    }
    if (_.contains(archiveCompanyData.invest, userId)) {
      throw new Meteor.Error(403, '您已經投資過此保管庫公司了！');
    }
    const createdAt = new Date();
    dbLog.insert({
      logType: '參與投資',
      userId: [userId],
      companyId: companyId,
      data: {
        companyName: archiveCompanyData.name,
        fund: amount
      },
      createdAt: createdAt
    });
    Meteor.users.update(userId, {
      $inc: {
        'profile.money': amount * -1
      }
    });
    archiveCompanyData.invest.push(userId);
    if (archiveCompanyData.invest.length >= Meteor.settings.public.archiveReviveNeedUsers) {
      const shuffledInvestUserId = _.shuffle(archiveCompanyData.invest);
      const managerId = _.find(shuffledInvestUserId, (userId) => {
        const manager = Meteor.users.findOne(userId, {
          fields: {
            _id: 1,
            profile: 1
          }
        });

        return manager && ! manager.profile.isInVacation && ! _.contains(manager.profile.ban, 'manager');
      }) || '!none';
      dbLog.insert({
        logType: '公司復活',
        userId: archiveCompanyData.invest,
        companyId: companyId,
        data: {
          manager: managerId
        },
        createdAt: new Date(createdAt.getTime() + 1)
      });
      const invest = _.map(archiveCompanyData.invest, (userId) => {
        return {userId, amount};
      });
      dbCompanyArchive.update(companyId, {
        $set: {
          status: 'foundation',
          invest: []
        }
      });
      dbFoundations.insert({
        _id: companyId,
        companyName: archiveCompanyData.name,
        manager: managerId,
        tags: archiveCompanyData.tags,
        pictureSmall: archiveCompanyData.pictureSmall,
        pictureBig: archiveCompanyData.pictureBig,
        description: archiveCompanyData.description,
        invest: invest,
        createdAt: new Date(createdAt.getTime() + 1)
      });
    }
    else {
      dbCompanyArchive.update(companyId, {
        $set: {
          invest: archiveCompanyData.invest
        }
      });
    }
    release();
  });
}
//兩秒鐘最多一次
limitMethod('investArchiveCompany', 1, 2000);
