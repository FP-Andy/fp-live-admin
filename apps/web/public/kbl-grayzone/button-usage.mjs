// Explicit IDs only: never capture button text, typed content, coordinates or URLs.
export const tracked={frame:['confirm','saveRecord','saveUniforms','continue','previous','next'],objects:['infer','addObject','addBall','redrawBox','setFoot','reviewUnplaced','undo','redo','applyBox','applyFoot','resetObjects'],joints:['infer','undo','redo','fitFocus','openArmEditor','coordinate'],spatial:['save','saveAll','markPoint','resetPoint','applyPoint','aimMap','mapUndo','moveMap','applyPosition','proposePosition','placePartial','acceptProposal','refereeView','refreshCrew','applyEdit','flipBody','autoBody','applySharedPose','clearSharedPose','createVideo','createRefitVideo','refreshVideos'],report:['saveAll','generate','download','checkVideoReady','exportPackage','packageDownload','compose']};
export function trackedAction(stage,event){
 if(!event.isTrusted)return null;
 const target=event.target?.closest?.('button[id],a[id]');
 return target&&!target.disabled&&tracked[stage]?.includes(target.id)?target.id:null;
}
